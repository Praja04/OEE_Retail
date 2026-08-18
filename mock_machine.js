const mqtt = require('mqtt');
require('dotenv').config();

const brokerUrl = process.env.MQTT_BROKER || 'mqtt://10.11.11.200';
const brokerPort = parseInt(process.env.MQTT_PORT || '1883');
const topic = process.env.MQTT_TOPIC_SUB || 'OEE_D1';

console.log(`[Mock Machine] Connecting to broker at ${brokerUrl}:${brokerPort}...`);
const client = mqtt.connect(brokerUrl, { port: brokerPort });

client.on('connect', () => {
  console.log('[Mock Machine] Connected to MQTT broker.');
  
  let oeeValue = 11;
  let stopShiftValue = 0;
  let ctProductValue = 26571;

  const resetTopic = process.env.MQTT_TOPIC_PUB || 'RST_D1';
  client.subscribe(resetTopic);

  client.on('message', (t, msg) => {
    if (t === resetTopic) {
      try {
        const p = JSON.parse(msg.toString());
        if (p && p.RST_D1 && p.RST_D1[0] === 1) {
          console.log(`[Mock Machine] Received Reset Signal! Resetting OEE_D1 to 0.`);
          oeeValue = 0;
        }
      } catch (e) {}
    }
  });

  // Publish mock data every 5 seconds
  const interval = setInterval(() => {
    // Simulate some simple data changes over time
    oeeValue += 1;
    ctProductValue += Math.floor(Math.random() * 5) + 1;
    if (Math.random() > 0.9) {
      stopShiftValue += 1;
    }

    const payload = {
      d: {
        OEE_D1: [oeeValue],
        STOP_SHIFTD1: [stopShiftValue],
        CT_PRODUCTD1: [ctProductValue]
      },
      ts: new Date().toISOString()
    };

    const payloadStr = JSON.stringify(payload);
    console.log(`[Mock Machine] Publishing data to ${topic}: ${payloadStr}`);
    client.publish(topic, payloadStr, { qos: 0 });
  }, 5000);

  process.on('SIGINT', () => {
    clearInterval(interval);
    client.end();
    console.log('[Mock Machine] Stopped.');
    process.exit(0);
  });
});

client.on('error', (err) => {
  console.error('[Mock Machine] Error:', err.message);
});
