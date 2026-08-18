const mqtt = require('mqtt');
const machineManager = require('./machineManager');
require('dotenv').config();

const brokerUrl = process.env.MQTT_BROKER || 'mqtt://10.11.11.200';
const brokerPort = parseInt(process.env.MQTT_PORT || '1883');

let client = null;

function connectMqtt(machines = []) {
  console.log(`[MQTT] Connecting to broker at ${brokerUrl}:${brokerPort}...`);

  client = mqtt.connect(brokerUrl, {
    port: brokerPort,
    reconnectPeriod: 5000,
    connectTimeout: 30000
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected to broker successfully.');

    machines.forEach(machine => {
      client.subscribe(machine.topicSub, (err) => {
        if (err) {
          console.error(`[MQTT] [${machine.id}] Failed to subscribe to topic '${machine.topicSub}':`, err.message);
        } else {
          console.log(`[MQTT] [${machine.id}] Subscribed to topic: '${machine.topicSub}'`);
        }
      });
    });
  });

  client.on('message', (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      // Match topic with machine config
      machines.forEach(machine => {
        if (topic === machine.topicSub) {
          machineManager.updateTelemetry(machine, payload);
        }
      });
    } catch (e) {
      // Ignore non-JSON messages
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT] Connection error:', err.message);
  });

  return client;
}

/**
 * Sends a reset pulse (1 -> 500ms -> 0) via MQTT for a specific machine.
 */
function sendResetPulse(topicPub, resetField) {
  return new Promise((resolve, reject) => {
    if (!client || !client.connected) {
      console.warn(`[MQTT] Broker not connected. Skipping reset publish to ${topicPub}.`);
      return resolve({ success: false, reason: 'Disconnected' });
    }

    const resetOnPayload = JSON.stringify({ [resetField]: [1] });
    const resetOffPayload = JSON.stringify({ [resetField]: [0] });

    console.log(`[MQTT] Publishing reset ON (1) to topic '${topicPub}'...`);

    client.publish(topicPub, resetOnPayload, { qos: 1 }, (pubErr) => {
      if (pubErr) {
        console.error(`[MQTT] Failed to publish reset ON (1) to ${topicPub}:`, pubErr.message);
        return reject(pubErr);
      }

      setTimeout(() => {
        console.log(`[MQTT] Publishing reset OFF (0) to topic '${topicPub}'...`);
        client.publish(topicPub, resetOffPayload, { qos: 1 }, (offErr) => {
          if (offErr) {
            console.error(`[MQTT] Failed to publish reset OFF (0) to ${topicPub}:`, offErr.message);
            return reject(offErr);
          }
          resolve({ success: true });
        });
      }, 500);
    });
  });
}

/**
 * Level 2 Verification: Waits for hardware PLC feedback showing counter reset <= 2.
 */
function waitForHardwareResetVerification(machineConfig, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let resolved = false;

    const onMessageCheck = (topic, message) => {
      if (topic === machineConfig.topicSub) {
        try {
          const payload = JSON.parse(message.toString());
          const d = payload?.d || payload;
          const rawOee = d?.[machineConfig.topicSub] ?? d?.[machineConfig.oeeField];
          const oeeVal = Array.isArray(rawOee) ? (parseInt(rawOee[0]) || 0) : (parseInt(rawOee) || 0);

          if (oeeVal <= 2) {
            resolved = true;
            if (client) client.removeListener('message', onMessageCheck);
            return resolve({ success: true, verifiedValue: oeeVal });
          }
        } catch (e) {
          // Continue listening
        }
      }
    };

    if (client) client.on('message', onMessageCheck);

    setTimeout(() => {
      if (!resolved) {
        if (client) client.removeListener('message', onMessageCheck);
        const state = machineManager.getMachineState(machineConfig.id);
        const currentOee = state?.lastKnownData?.oee;
        if (currentOee !== null && currentOee <= 2) {
          return resolve({ success: true, verifiedValue: currentOee });
        }
        resolve({ success: false, reason: `PLC counter for ${machineConfig.id} did not return to <= 2` });
      }
    }, timeoutMs);
  });
}

module.exports = {
  connectMqtt,
  sendResetPulse,
  waitForHardwareResetVerification,
  getClient: () => client
};
