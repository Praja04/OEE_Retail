const { getActiveMachines } = require('./config/machines');
const { initializeAllTables } = require('./config/database');
const machineManager = require('./services/machineManager');
const { connectMqtt } = require('./services/mqttService');
const { scheduleHourlyLoop } = require('./services/hourlyScheduler');
require('dotenv').config();

const timezone = process.env.TZ || 'Asia/Jakarta';
process.env.TZ = timezone;

async function startDaemon() {
  const activeMachines = getActiveMachines();
  const machineListStr = activeMachines.map(m => m.id).join(', ');

  console.log(`===================================================`);
  console.log(`[SYSTEM] Starting OEE Retail Multi-Machine Daemon`);
  console.log(`[SYSTEM] Timezone        : ${timezone}`);
  console.log(`[SYSTEM] Active Machines : [ ${machineListStr} ] (${activeMachines.length} machine(s))`);
  console.log(`===================================================`);

  // 1. Initialize Database Schemas for all active machines
  try {
    await initializeAllTables(activeMachines);
  } catch (error) {
    console.warn('[SYSTEM] Database initialization warning:', error.message);
  }

  // 2. Initialize In-Memory State Manager
  machineManager.initMachines(activeMachines);

  // 3. Connect to MQTT Broker & Subscribe to all machine topics
  connectMqtt(activeMachines);

  // 4. Start WIB Hourly Scheduler Loop
  scheduleHourlyLoop(activeMachines);
}

startDaemon().catch(err => {
  console.error('[SYSTEM] Fatal error during daemon startup:', err);
});
