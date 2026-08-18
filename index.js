const mqtt = require('mqtt');
const { pool, initializeDatabase } = require('./db');
require('dotenv').config();

// Timezone Configuration (Default: WIB / Asia/Jakarta / UTC+7)
const timezone = process.env.TZ || 'Asia/Jakarta';
process.env.TZ = timezone;

// Configuration
const brokerUrl = process.env.MQTT_BROKER || 'mqtt://10.11.11.200';
const brokerPort = parseInt(process.env.MQTT_PORT || '1883');
const subscribeTopic = process.env.MQTT_TOPIC_SUB || 'OEE_D1';
const publishTopic = process.env.MQTT_TOPIC_PUB || 'RST_D1';

// In-Memory cache for the last received data
let lastKnownData = {
  oee_d1: null,
  stop_shiftd1: null,
  ct_productd1: null,
  lastReceivedAt: null
};

// Peak trackers for OEE uptime and CT_Product counter in the current hour
let peakOeeThisHour = 0;
let peakProductThisHour = 0;

// Deduplication guard to ensure hourly process runs AT MOST ONCE per hour
let lastProcessedHourTimestamp = null;

let timerId = null;
let mqttClient = null;

/**
 * Helper function to extract date components and format strings locked to WIB (Asia/Jakarta) timezone.
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
    yyyy,
    mm,
    dd,
    hh: parseInt(hh, 10),
    min: parseInt(min, 10),
    sec: parseInt(sec, 10),
    jamLabel,
    mysqlDatetime,
    displayString
  };
}

/**
 * Helper to get the target top-of-hour timestamp.
 * If called near the top of the hour (e.g. 10:59:59), rounds up to 11:00:00.
 */
function getHourlyTargetDetails(date = new Date()) {
  const ms = date.getTime();
  const roundedMs = Math.round(ms / 3600000) * 3600000;
  return getWibDateDetails(new Date(roundedMs));
}

// Function to publish Reset Pulse (1 -> wait 500ms -> 0) via MQTT
function sendResetPulse(client = mqttClient) {
  return new Promise((resolve, reject) => {
    const resetOnPayload = JSON.stringify({ RST_D1: [1] });
    const resetOffPayload = JSON.stringify({ RST_D1: [0] });

    console.log(`[MQTT] Publishing reset ON (1) to topic ${publishTopic}...`);
    
    if (!client || !client.connected) {
      console.warn(`[MQTT] Broker not connected. Skipping reset publish.`);
      return resolve({ success: false, reason: 'Disconnected' });
    }

    client.publish(publishTopic, resetOnPayload, { qos: 1 }, (pubErr) => {
      if (pubErr) {
        console.error(`[MQTT] Failed to publish reset ON (1):`, pubErr.message);
        return reject(pubErr);
      }
      console.log(`[MQTT] Reset ON (1) published: ${resetOnPayload}`);

      setTimeout(() => {
        console.log(`[MQTT] Publishing reset OFF (0) to topic ${publishTopic}...`);
        client.publish(publishTopic, resetOffPayload, { qos: 1 }, (offErr) => {
          if (offErr) {
            console.error(`[MQTT] Failed to publish reset OFF (0):`, offErr.message);
            return reject(offErr);
          }
          console.log(`[MQTT] Reset OFF (0) published: ${resetOffPayload}`);
          resolve({ success: true });
        });
      }, 500);
    });
  });
}

// Helper function to verify Level 2 (PLC Hardware Feedback Verification)
// Waits up to timeoutMs to confirm PLC published OEE_D1 reset value (<= 2)
function waitForPlcResetVerification(timeoutMs = 2500) {
  return new Promise((resolve) => {
    // If lastKnownData is already reset (<= 2):
    if (lastKnownData.oee_d1 !== null && lastKnownData.oee_d1 <= 2) {
      return resolve({ success: true, verifiedValue: lastKnownData.oee_d1 });
    }

    let resolved = false;

    const onMessageCheck = (topic, message) => {
      if (topic === subscribeTopic) {
        try {
          const payload = JSON.parse(message.toString());
          if (payload && payload.d && payload.d.OEE_D1) {
            const val = payload.d.OEE_D1[0];
            if (val !== null && val <= 2) {
              resolved = true;
              mqttClient.removeListener('message', onMessageCheck);
              clearTimeout(timer);
              return resolve({ success: true, verifiedValue: val });
            }
          }
        } catch (e) {}
      }
    };

    mqttClient.on('message', onMessageCheck);

    const timer = setTimeout(() => {
      if (!resolved) {
        mqttClient.removeListener('message', onMessageCheck);
        if (lastKnownData.oee_d1 !== null && lastKnownData.oee_d1 <= 2) {
          return resolve({ success: true, verifiedValue: lastKnownData.oee_d1 });
        }
        resolve({ success: false, reason: 'PLC counter did not return to 0 (Level 2 Hardware Verification Failed)' });
      }
    }, timeoutMs);
  });
}

// Hourly execution logic: 
// DUAL-LEVEL VERIFICATION TRANSACTION FLOW:
// 1. Simpan Data ke MySQL DB dulu (START TRANSACTION + INSERT)
// 2. Kirim Sinyal Reset Pulse (RST_D1 = 1 -> 500ms -> 0) via MQTT (Level 1 Check: QoS 1 Network Ack)
// 3. Verifikasi Balasan PLC (Level 2 Check: PLC Hardware Feedback OEE_D1 <= 2)
// 4. Jika Level 1 & Level 2 BERHASIL -> COMMIT (Data permanen tersimpan di DB)
// 5. Jika Level 1 atau Level 2 GAGAL -> ROLLBACK (Batal simpan! Data di-undo dari DB)
async function executeHourlyProcess() {
  const serverNow = new Date();
  const wibTarget = getHourlyTargetDetails(serverNow);

  console.log(`[FLOW] ===================================================`);
  console.log(`[FLOW] [${getWibDateDetails(serverNow).displayString}] Target Hour: ${wibTarget.mysqlDatetime} (${wibTarget.jamLabel})`);

  // Deduplication check: Prevent double execution for the same hour
  if (lastProcessedHourTimestamp === wibTarget.mysqlDatetime) {
    console.warn(`[FLOW] Hourly process already completed for ${wibTarget.mysqlDatetime}. Skipping duplicate run.`);
    console.log(`[FLOW] ===================================================`);
    return;
  }

  // Determine accumulated OEE Uptime before reset
  let oeeToSave = lastKnownData.oee_d1;
  if ((oeeToSave === null || oeeToSave === 0) && peakOeeThisHour > 0) {
    oeeToSave = peakOeeThisHour;
  }

  // Determine accumulated CT_Product Counter before reset
  let productToSave = lastKnownData.ct_productd1;
  if ((productToSave === null || productToSave === 0 || productToSave < peakProductThisHour) && peakProductThisHour > 0) {
    productToSave = peakProductThisHour;
  }
  if (productToSave === null) productToSave = 0;

  if (oeeToSave === null || oeeToSave === 0) {
    console.warn(`[FLOW] OEE minute is 0 (Mesin tidak jalan / libur). Skipping database save and reset.`);
    lastProcessedHourTimestamp = wibTarget.mysqlDatetime;
    peakOeeThisHour = 0;
    peakProductThisHour = 0;
    console.log(`[FLOW] ===================================================`);
    return;
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Check existing record
    const [existingRows] = await connection.query(
      'SELECT id FROM oee_d1 WHERE machine_ts = ?',
      [wibTarget.mysqlDatetime]
    );

    if (existingRows.length > 0) {
      console.warn(`[FLOW] STEP 1 (SAVE): Data for WIB ${wibTarget.mysqlDatetime} (${wibTarget.jamLabel}) already exists in DB (ID: ${existingRows[0].id}). Skipping DB insert.`);
      await connection.rollback();
      lastProcessedHourTimestamp = wibTarget.mysqlDatetime;
      console.log(`[FLOW] ===================================================`);
      return;
    }

    // STEP 1: SIMPAN DULU (STAGED IN TRANSACTION)
    const insertQuery = `
      INSERT INTO oee_d1 (oee_d1, ct_productd1, jam, machine_ts) 
      VALUES (?, ?, ?, ?)
    `;
    
    console.log(`[FLOW] STEP 1 (SIMPAN DULU): Staging data to DB inside Transaction BEFORE reset pulse:`, {
      oee_d1: oeeToSave,
      ct_productd1: productToSave,
      jam: wibTarget.jamLabel,
      machine_ts: wibTarget.mysqlDatetime
    });

    const [insertResult] = await connection.query(insertQuery, [
      oeeToSave,
      productToSave,
      wibTarget.jamLabel,
      wibTarget.mysqlDatetime
    ]);

    console.log(`[FLOW] STEP 1 PENDING: Data staged in DB (Insert ID: ${insertResult.insertId}). Waiting for Reset verification...`);

    // STEP 2A: RESET PULSE (LEVEL 1 CHECK - MQTT QoS 1 ACK)
    console.log(`[FLOW] STEP 2A (LEVEL 1 CHECK): Sending RST_D1 reset pulse (1 -> 500ms -> 0) via MQTT...`);
    const resetResult = await sendResetPulse(mqttClient);

    if (!resetResult || !resetResult.success) {
      console.warn(`[FLOW] STEP 2A FAILED (LEVEL 1): Reset pulse delivery failed (${resetResult?.reason || 'Unknown'}).`);
      await connection.rollback();
      console.warn(`[FLOW] ROLLBACK EXECUTED: DB save CANCELLED. Counter will accumulate (e.g. 54 -> 110 min).`);
      console.log(`[FLOW] ===================================================`);
      return;
    }

    console.log(`[FLOW] STEP 2A PASSED (LEVEL 1): Reset pulse delivered to MQTT broker.`);

    // STEP 2B: VERIFIKASI PLC RESET (LEVEL 2 CHECK - HARDWARE COUNTER RESET TO 0)
    console.log(`[FLOW] STEP 2B (LEVEL 2 CHECK): Verifying PLC hardware feedback (waiting for OEE_D1 <= 2)...`);
    const level2Result = await waitForPlcResetVerification(2500);

    if (!level2Result.success) {
      console.warn(`[FLOW] STEP 2B FAILED (LEVEL 2): ${level2Result.reason}`);
      await connection.rollback();
      console.warn(`[FLOW] ROLLBACK EXECUTED: PLC hardware did not confirm reset. DB save CANCELLED. Counter will accumulate (e.g. 54 -> 110 min).`);
      console.log(`[FLOW] ===================================================`);
      return;
    }

    console.log(`[FLOW] STEP 2B PASSED (LEVEL 2): PLC hardware reset confirmed (Verified OEE_D1 = ${level2Result.verifiedValue}).`);

    // STEP 3: BOTH LEVEL 1 & LEVEL 2 PASSED -> COMMIT TRANSACTION
    await connection.commit();
    lastProcessedHourTimestamp = wibTarget.mysqlDatetime;
    peakOeeThisHour = 0;
    peakProductThisHour = 0;
    console.log(`[FLOW] STEP 3 SUCCESS (COMMIT): Level 1 & Level 2 Verified! Transaction COMMITTED to DB permanently.`);

  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (rbErr) {}
    }
    console.error(`[FLOW] ERROR during transaction process:`, err.message);
  } finally {
    if (connection) connection.release();
  }

  console.log(`[FLOW] ===================================================`);
}

// Native server-time scheduler aligned with 200ms AFTER the top of the next hour WIB (HH:00:00.200)
function scheduleNextHourlyJob() {
  const now = new Date();
  
  // Calculate top of next hour + 200ms
  const currentHourMs = Math.floor(now.getTime() / 3600000) * 3600000;
  const nextHourMs = currentHourMs + 3600000 + 200;
  let msUntilNextHour = nextHourMs - now.getTime();

  if (msUntilNextHour <= 0) {
    msUntilNextHour = 3600000;
  }

  const nextWibDetails = getWibDateDetails(new Date(nextHourMs));
  console.log(`[TIMER] Current Time (WIB): ${getWibDateDetails(now).displayString}`);
  console.log(`[TIMER] Next hourly process scheduled for WIB ${nextWibDetails.mysqlDatetime} (in ${Math.round(msUntilNextHour / 1000)}s / ~${Math.round(msUntilNextHour / 60000)} mins).`);

  if (timerId) clearTimeout(timerId);
  timerId = setTimeout(async () => {
    await executeHourlyProcess();
    scheduleNextHourlyJob();
  }, msUntilNextHour);
}

async function start() {
  console.log(`[SYSTEM] Starting OEE Retail Daemon (Timezone: ${timezone})...`);
  console.log(`[SYSTEM] Mode Murni Database Daemon Aktif.`);
  console.log(`[SYSTEM] Sistem berfokus 100% pada pencatatan Database MySQL & MQTT.`);
  
  // 1. Initialize Database (Non-blocking warning on failure)
  try {
    await initializeDatabase();
  } catch (error) {
    console.warn('[SYSTEM] Database initialization warning:', error.message);
  }

  // 2. Connect to MQTT Broker
  console.log(`[MQTT] Connecting to broker at ${brokerUrl}:${brokerPort}...`);
  mqttClient = mqtt.connect(brokerUrl, {
    port: brokerPort,
    reconnectPeriod: 5000,
    connectTimeout: 30000
  });

  mqttClient.on('connect', () => {
    console.log('[MQTT] Connected to broker successfully.');
    mqttClient.subscribe(subscribeTopic, (err) => {
      if (err) {
        console.error(`[MQTT] Failed to subscribe to topic ${subscribeTopic}:`, err.message);
      } else {
        console.log(`[MQTT] Subscribed to topic: ${subscribeTopic}`);
      }
    });

    // 3. Start Native WIB Hourly Server-Time Scheduler
    scheduleNextHourlyJob();
  });

  mqttClient.on('message', (topic, message) => {
    if (topic === subscribeTopic) {
      try {
        const payload = JSON.parse(message.toString());
        if (payload && payload.d) {
          const d = payload.d;
          
          const newOee = (d.OEE_D1 && d.OEE_D1.length > 0) ? d.OEE_D1[0] : lastKnownData.oee_d1;
          const newProduct = (d.CT_PRODUCTD1 && d.CT_PRODUCTD1.length > 0) ? d.CT_PRODUCTD1[0] : lastKnownData.ct_productd1;

          if (newOee !== null && newOee > 0) {
            if (newOee >= peakOeeThisHour) {
              peakOeeThisHour = newOee;
            }
          }

          if (newProduct !== null && newProduct > 0) {
            if (newProduct >= peakProductThisHour) {
              peakProductThisHour = newProduct;
            }
          }

          lastKnownData.oee_d1 = newOee;
          lastKnownData.ct_productd1 = newProduct;
          lastKnownData.stop_shiftd1 = (d.STOP_SHIFTD1 && d.STOP_SHIFTD1.length > 0) ? d.STOP_SHIFTD1[0] : lastKnownData.stop_shiftd1;
          lastKnownData.lastReceivedAt = new Date();

          const wibNow = getWibDateDetails(lastKnownData.lastReceivedAt);
          console.log(`[MQTT] [${wibNow.displayString}] Updated cached data:`, {
            oee_d1: lastKnownData.oee_d1,
            peakOeeThisHour,
            ct_productd1: lastKnownData.ct_productd1,
            peakProductThisHour,
            stop_shiftd1: lastKnownData.stop_shiftd1
          });
        }
      } catch (err) {
        console.error('[MQTT] Failed to parse message JSON:', err.message);
      }
    }
  });

  mqttClient.on('error', (err) => {
    console.error('[MQTT] Connection error:', err.message);
  });

  mqttClient.on('close', () => {
    console.warn('[MQTT] Connection closed.');
  });

  // Handle termination signals for clean exit
  const handleExit = async (signal) => {
    console.log(`[SYSTEM] Received ${signal}. Shutting down gracefully...`);
    if (timerId) clearTimeout(timerId);
    if (mqttClient) mqttClient.end();
    try { await pool.end(); } catch (e) {}
    console.log('[SYSTEM] Daemon stopped.');
    process.exit(0);
  };

  process.on('SIGINT', () => handleExit('SIGINT'));
  process.on('SIGTERM', () => handleExit('SIGTERM'));
}

start().catch(err => {
  console.error('[SYSTEM] Startup error:', err);
});
