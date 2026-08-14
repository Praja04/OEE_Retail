const express = require('express');
const path = require('path');
const mqtt = require('mqtt');
const os = require('os');
const { pool, initializeDatabase } = require('./db');
require('dotenv').config();

// Timezone Configuration (Default: WIB / Asia/Jakarta / UTC+7)
const timezone = process.env.TZ || 'Asia/Jakarta';
process.env.TZ = timezone;

// Port Configuration
const PORT = process.env.PORT || 3000;

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

// Hourly execution logic: 
// STRICT FLOW:
// 1. READ & SAVE accumulated data to MySQL DB FIRST
// 2. ONLY AFTER DB save succeeds, send Reset Pulse (RST_D1 = 1) via MQTT
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
  // Fallback to peakOeeThisHour if lastKnownData was zeroed out right at top-of-hour
  let oeeToSave = lastKnownData.oee_d1;
  if ((oeeToSave === null || oeeToSave === 0) && peakOeeThisHour > 0) {
    oeeToSave = peakOeeThisHour;
  }

  // Determine accumulated CT_Product Counter before reset
  // Fallback to peakProductThisHour if CT_Product was zeroed out before top-of-hour
  let productToSave = lastKnownData.ct_productd1;
  if ((productToSave === null || productToSave === 0 || productToSave < peakProductThisHour) && peakProductThisHour > 0) {
    productToSave = peakProductThisHour;
  }
  if (productToSave === null) productToSave = 0;

  if (oeeToSave === null) {
    console.warn('[FLOW] No data received from machine yet. Skipping save and reset.');
    console.log(`[FLOW] ===================================================`);
    return;
  }

  // Mark this hour as processed to block race condition executions
  lastProcessedHourTimestamp = wibTarget.mysqlDatetime;

  // STEP 1: READ & SAVE TO DATABASE FIRST
  let dbSavedSuccessfully = false;
  try {
    const [existingRows] = await pool.query(
      'SELECT id FROM oee_d1 WHERE machine_ts = ?',
      [wibTarget.mysqlDatetime]
    );

    if (existingRows.length > 0) {
      console.warn(`[FLOW] STEP 1 (SAVE): Data for WIB ${wibTarget.mysqlDatetime} (${wibTarget.jamLabel}) already exists in DB (ID: ${existingRows[0].id}). Skipping DB insert.`);
      dbSavedSuccessfully = true;
    } else {
      const query = `
        INSERT INTO oee_d1 (oee_d1, ct_productd1, jam, machine_ts) 
        VALUES (?, ?, ?, ?)
      `;
      
      console.log(`[FLOW] STEP 1 (SAVE): Saving accumulated data to DB BEFORE sending reset pulse:`, {
        oee_d1: oeeToSave,
        ct_productd1: productToSave,
        jam: wibTarget.jamLabel,
        machine_ts: wibTarget.mysqlDatetime
      });

      const [result] = await pool.query(query, [
        oeeToSave,
        productToSave,
        wibTarget.jamLabel,
        wibTarget.mysqlDatetime
      ]);
      
      console.log(`[FLOW] STEP 1 SUCCESS: Data saved to DB with Insert ID: ${result.insertId}`);
      dbSavedSuccessfully = true;
    }
  } catch (dbErr) {
    console.error(`[FLOW] STEP 1 ERROR: Database operation failed:`, dbErr.message);
  }

  // STEP 2: ONLY AFTER SAVED TO DB -> SEND RST_D1 RESET PULSE
  if (dbSavedSuccessfully) {
    try {
      console.log(`[FLOW] STEP 2 (RESET): DB save complete. Now sending RST_D1 reset pulse (1 -> 500ms -> 0)...`);
      await sendResetPulse(mqttClient);
      
      // Reset peak trackers for the next hour
      peakOeeThisHour = 0;
      peakProductThisHour = 0;
      console.log(`[FLOW] STEP 2 SUCCESS: Reset pulse sent and peak trackers cleared.`);
    } catch (resetErr) {
      console.error(`[FLOW] STEP 2 ERROR: Reset pulse failed:`, resetErr.message);
    }
  } else {
    console.warn(`[FLOW] Aborting STEP 2 (RESET) because STEP 1 (DB SAVE) did not complete successfully.`);
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

// Setup Express App
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.get('/api/status', async (req, res) => {
  let previousHourCounter = 0;
  try {
    const [rows] = await pool.query('SELECT ct_productd1 FROM oee_d1 ORDER BY id DESC LIMIT 1');
    if (rows.length > 0 && rows[0].ct_productd1 !== null) {
      previousHourCounter = Number(rows[0].ct_productd1);
    }
  } catch (dbErr) {
    console.warn('[API] Could not fetch previousHourCounter from DB:', dbErr.message);
  }

  res.json({
    success: true,
    lastKnownData,
    previousHourCounter,
    peakOeeThisHour,
    peakProductThisHour,
    lastProcessedHourTimestamp,
    mqttConnected: mqttClient ? mqttClient.connected : false
  });
});

app.get('/api/history', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM oee_d1 ORDER BY id DESC LIMIT 8');
    res.json(rows);
  } catch (err) {
    console.error('[API] Failed to fetch history:', err.message);
    res.status(500).json({ error: 'Failed to fetch database history', details: err.message });
  }
});

app.post('/api/reset', async (req, res) => {
  try {
    console.log('[API] Manual reset triggered from UI. Executing Read & Save -> Reset flow...');
    // Force allow manual run if triggered via button
    lastProcessedHourTimestamp = null;
    await executeHourlyProcess();
    res.json({ success: true, message: 'Data saved to DB and Reset pulse (RST_D1) sent successfully' });
  } catch (err) {
    console.error('[API] Manual reset error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

async function start() {
  console.log(`[SYSTEM] Starting OEE Retail Daemon (Timezone: ${timezone})...`);
  
  // 1. Initialize Database (Non-blocking warning on failure)
  try {
    await initializeDatabase();
  } catch (error) {
    console.warn('[SYSTEM] Database initialization warning:', error.message);
  }

  // 2. Web App Server Optional Toggle (Default: OFF for pure backend database insert)
  const enableWebServer = process.env.ENABLE_WEB_SERVER === 'true';
  if (enableWebServer) {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[HTTP] Web App Server running & ready!`);
      console.log(`[HTTP] 💻 Komputer Ini: http://localhost:${PORT}`);
      
      const interfaces = os.networkInterfaces();
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            console.log(`[HTTP] 🌐 Link Jaringan Lokal (${name}): http://${iface.address}:${PORT}`);
          }
        }
      }
    });
  } else {
    console.log(`[SYSTEM] Mode Murni Database Daemon Aktif.`);
    console.log(`[SYSTEM] Port Web (3000) TIDAK dibuka. Sistem berfokus 100% pada pencatatan Database MySQL & MQTT.`);
  }

  // 3. Connect to MQTT Broker
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

    // 4. Start Native WIB Hourly Server-Time Scheduler
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
