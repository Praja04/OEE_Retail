const { pool } = require('../config/database');
const machineManager = require('./machineManager');
const { sendResetPulse, waitForHardwareResetVerification } = require('./mqttService');
require('dotenv').config();

const timezone = process.env.TZ || 'Asia/Jakarta';

/**
 * Returns formatted date components locked to WIB (Asia/Jakarta) timezone.
 */
function getWibDateDetails(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type) => parts.find(p => p.type === type)?.value || '00';

  const yyyy = getPart('year');
  const mm = getPart('month');
  const dd = getPart('day');
  let hh = getPart('hour');
  if (hh === '24') hh = '00';
  const min = getPart('minute');
  const sec = getPart('second');

  const jamLabel = `${hh}.00`;
  const mysqlDatetime = `${yyyy}-${mm}-${dd} ${hh}:00:00`;
  const displayString = `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec} WIB`;

  return {
    yyyy, mm, dd, hh: parseInt(hh, 10), min: parseInt(min, 10), sec: parseInt(sec, 10),
    jamLabel, mysqlDatetime, displayString
  };
}

function getHourlyTargetDetails(date = new Date()) {
  const ms = date.getTime();
  const roundedMs = Math.round(ms / 3600000) * 3600000;
  return getWibDateDetails(new Date(roundedMs));
}

/**
 * Executes the dual-verification hourly process for a single machine.
 */
async function processMachineHourly(machineConfig) {
  const serverNow = new Date();
  const wibTarget = getHourlyTargetDetails(serverNow);
  const state = machineManager.getMachineState(machineConfig.id);

  if (!state) return;

  console.log(`[FLOW] [${machineConfig.id}] Processing Machine at WIB ${wibTarget.mysqlDatetime} (${wibTarget.jamLabel})`);

  // Deduplication check
  if (state.lastProcessedHourTimestamp === wibTarget.mysqlDatetime) {
    console.warn(`[FLOW] [${machineConfig.id}] Already processed for ${wibTarget.mysqlDatetime}. Skipping duplicate.`);
    return;
  }

  let oeeToSave = state.lastKnownData.oee;
  if ((oeeToSave === null || oeeToSave === 0) && state.peakOeeThisHour > 0) {
    oeeToSave = state.peakOeeThisHour;
  }

  let productToSave = state.lastKnownData.product;
  if ((productToSave === null || productToSave === 0 || productToSave < state.peakProductThisHour) && state.peakProductThisHour > 0) {
    productToSave = state.peakProductThisHour;
  }
  if (productToSave === null) productToSave = 0;

  if (oeeToSave === null || oeeToSave === 0) {
    console.warn(`[FLOW] [${machineConfig.id}] OEE minute is 0 (Idle / Shutdown). Skipping DB save & reset.`);
    state.lastProcessedHourTimestamp = wibTarget.mysqlDatetime;
    machineManager.resetPeakTrackers(machineConfig.id);
    return;
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Check existing record
    const [existingRows] = await connection.query(
      `SELECT id FROM \`${machineConfig.tableName}\` WHERE machine_ts = ?`,
      [wibTarget.mysqlDatetime]
    );

    if (existingRows.length > 0) {
      console.warn(`[FLOW] [${machineConfig.id}] Record for ${wibTarget.mysqlDatetime} already exists in DB. Skipping.`);
      await connection.rollback();
      state.lastProcessedHourTimestamp = wibTarget.mysqlDatetime;
      return;
    }

    // STEP 1: SIMPAN DULU IN TRANSACTION
    const insertQuery = `
      INSERT INTO \`${machineConfig.tableName}\` (\`${machineConfig.oeeField}\`, \`${machineConfig.productField}\`, jam, machine_ts)
      VALUES (?, ?, ?, ?)
    `;

    console.log(`[FLOW] [${machineConfig.id}] STEP 1 (SIMPAN DULU): Staging data in DB transaction:`, {
      [machineConfig.oeeField]: oeeToSave,
      [machineConfig.productField]: productToSave,
      jam: wibTarget.jamLabel,
      machine_ts: wibTarget.mysqlDatetime
    });

    const [insertResult] = await connection.query(insertQuery, [
      oeeToSave,
      productToSave,
      wibTarget.jamLabel,
      wibTarget.mysqlDatetime
    ]);

    // STEP 2A: RESET PULSE (LEVEL 1 CHECK - MQTT QoS 1 ACK)
    console.log(`[FLOW] [${machineConfig.id}] STEP 2A (LEVEL 1 CHECK): Sending reset pulse via MQTT...`);
    const resetResult = await sendResetPulse(machineConfig.topicPub, machineConfig.resetField);

    if (!resetResult || !resetResult.success) {
      console.warn(`[FLOW] [${machineConfig.id}] STEP 2A FAILED (LEVEL 1): Reset pulse delivery failed.`);
      await connection.rollback();
      console.warn(`[FLOW] [${machineConfig.id}] ROLLBACK EXECUTED: DB save cancelled.`);
      return;
    }

    // STEP 2B: HARDWARE VERIFICATION (LEVEL 2 CHECK - PLC feedback <= 2)
    console.log(`[FLOW] [${machineConfig.id}] STEP 2B (LEVEL 2 CHECK): Waiting for hardware PLC reset feedback...`);
    const hwCheck = await waitForHardwareResetVerification(machineConfig, 8000);

    if (!hwCheck.success) {
      console.warn(`[FLOW] [${machineConfig.id}] STEP 2B FAILED (LEVEL 2): PLC counter reset not confirmed.`);
      await connection.rollback();
      console.warn(`[FLOW] [${machineConfig.id}] ROLLBACK EXECUTED: DB save cancelled.`);
      return;
    }

    // STEP 3: COMMIT TRANSACTION
    await connection.commit();
    state.lastProcessedHourTimestamp = wibTarget.mysqlDatetime;
    machineManager.resetPeakTrackers(machineConfig.id);

    console.log(`[FLOW] [${machineConfig.id}] STEP 3 (SUCCESS): DB Transaction COMMITTED! Data saved permanently (ID: ${insertResult.insertId}).`);

  } catch (err) {
    if (connection) await connection.rollback();
    console.error(`[FLOW] [${machineConfig.id}] Hourly process error:`, err.message);
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Runs hourly process for all active machines in parallel.
 */
async function processAllMachinesHourly(machines = []) {
  console.log(`[SCHEDULER] Running hourly process for ${machines.length} active machine(s)...`);
  await Promise.all(machines.map(m => processMachineHourly(m)));
}

let timerId = null;

function scheduleHourlyLoop(machines = []) {
  const now = new Date();
  const currentHourMs = Math.floor(now.getTime() / 3600000) * 3600000;
  const nextHourMs = currentHourMs + 3600000 + 200;
  let msUntilNextHour = nextHourMs - now.getTime();

  if (msUntilNextHour <= 0) msUntilNextHour = 3600000;

  const nextWibDetails = getWibDateDetails(new Date(nextHourMs));
  console.log(`[TIMER] Current Time (WIB): ${getWibDateDetails(now).displayString}`);
  console.log(`[TIMER] Next hourly process scheduled for WIB ${nextWibDetails.mysqlDatetime} (in ${Math.round(msUntilNextHour / 1000)}s).`);

  if (timerId) clearTimeout(timerId);
  timerId = setTimeout(async () => {
    await processAllMachinesHourly(machines);
    scheduleHourlyLoop(machines);
  }, msUntilNextHour);
}

/**
 * Executes early save & reset when STOP_SHIFT = 1 is triggered mid-hour.
 */
async function processMachineStopShift(machineConfig) {
  const serverNow = new Date();
  
  // Calculate target next hour timestamp (e.g. at 01:34, target is 02:00:00)
  const currentHourMs = Math.floor(serverNow.getTime() / 3600000) * 3600000;
  const nextHourMs = currentHourMs + 3600000;
  const wibTarget = getWibDateDetails(new Date(nextHourMs));
  const state = machineManager.getMachineState(machineConfig.id);

  if (!state) return;

  console.log(`[STOP_SHIFT] [${machineConfig.id}] Triggered early save & reset at ${getWibDateDetails(serverNow).displayString} -> Target ${wibTarget.mysqlDatetime}`);

  // Deduplication check
  if (state.lastProcessedHourTimestamp === wibTarget.mysqlDatetime) {
    console.warn(`[STOP_SHIFT] [${machineConfig.id}] Already processed for ${wibTarget.mysqlDatetime}. Skipping duplicate.`);
    return;
  }

  let oeeToSave = state.lastKnownData.oee;
  if ((oeeToSave === null || oeeToSave === 0) && state.peakOeeThisHour > 0) {
    oeeToSave = state.peakOeeThisHour;
  }

  let productToSave = state.lastKnownData.product;
  if ((productToSave === null || productToSave === 0 || productToSave < state.peakProductThisHour) && state.peakProductThisHour > 0) {
    productToSave = state.peakProductThisHour;
  }
  if (productToSave === null) productToSave = 0;

  if (oeeToSave === null || oeeToSave === 0) {
    console.warn(`[STOP_SHIFT] [${machineConfig.id}] OEE minute is 0. Skipping DB save & reset.`);
    state.lastProcessedHourTimestamp = wibTarget.mysqlDatetime;
    machineManager.resetPeakTrackers(machineConfig.id);
    return;
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [existingRows] = await connection.query(
      `SELECT id FROM \`${machineConfig.tableName}\` WHERE machine_ts = ?`,
      [wibTarget.mysqlDatetime]
    );

    if (existingRows.length > 0) {
      console.warn(`[STOP_SHIFT] [${machineConfig.id}] Record for ${wibTarget.mysqlDatetime} already exists in DB. Skipping.`);
      await connection.rollback();
      state.lastProcessedHourTimestamp = wibTarget.mysqlDatetime;
      return;
    }

    const insertQuery = `
      INSERT INTO \`${machineConfig.tableName}\` (\`${machineConfig.oeeField}\`, \`${machineConfig.productField}\`, jam, machine_ts, is_stop_shift)
      VALUES (?, ?, ?, ?, 1)
    `;

    console.log(`[STOP_SHIFT] [${machineConfig.id}] Staging early data (is_stop_shift = 1):`, {
      [machineConfig.oeeField]: oeeToSave,
      [machineConfig.productField]: productToSave,
      jam: wibTarget.jamLabel,
      machine_ts: wibTarget.mysqlDatetime
    });

    const [insertResult] = await connection.query(insertQuery, [
      oeeToSave,
      productToSave,
      wibTarget.jamLabel,
      wibTarget.mysqlDatetime
    ]);

    console.log(`[STOP_SHIFT] [${machineConfig.id}] Sending reset pulse via MQTT...`);
    const resetResult = await sendResetPulse(machineConfig.topicPub, machineConfig.resetField);

    if (!resetResult || !resetResult.success) {
      console.warn(`[STOP_SHIFT] [${machineConfig.id}] Reset pulse delivery failed.`);
      await connection.rollback();
      return;
    }

    console.log(`[STOP_SHIFT] [${machineConfig.id}] Waiting for hardware PLC reset feedback...`);
    const hwCheck = await waitForHardwareResetVerification(machineConfig, 8000);

    if (!hwCheck.success) {
      console.warn(`[STOP_SHIFT] [${machineConfig.id}] PLC counter reset not confirmed.`);
      await connection.rollback();
      return;
    }

    await connection.commit();
    state.lastProcessedHourTimestamp = wibTarget.mysqlDatetime;
    machineManager.resetPeakTrackers(machineConfig.id);

    console.log(`[STOP_SHIFT] [${machineConfig.id}] SUCCESS: Early DB Transaction COMMITTED! Saved permanently (ID: ${insertResult.insertId}).`);

  } catch (err) {
    if (connection) await connection.rollback();
    console.error(`[STOP_SHIFT] [${machineConfig.id}] Process error:`, err.message);
  } finally {
    if (connection) connection.release();
  }
}

module.exports = {
  scheduleHourlyLoop,
  processAllMachinesHourly,
  processMachineStopShift
};
