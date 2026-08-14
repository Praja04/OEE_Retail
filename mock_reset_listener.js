const mqtt = require('mqtt');
require('dotenv').config();

const brokerUrl = process.env.MQTT_BROKER || 'mqtt://10.11.11.200';
const brokerPort = parseInt(process.env.MQTT_PORT || '1883');
const topic = process.env.MQTT_TOPIC_PUB || 'RST_D1';

console.log(`[Mock Reset Listener] Connecting to broker at ${brokerUrl}:${brokerPort}...`);
const client = mqtt.connect(brokerUrl, { port: brokerPort });

client.on('connect', () => {
  console.log('[Mock Reset Listener] Connected to MQTT broker.');
  
  client.subscribe(topic, (err) => {
    if (err) {
      console.error(`[Mock Reset Listener] Failed to subscribe to topic ${topic}:`, err.message);
    } else {
      console.log(`[Mock Reset Listener] Subscribed to topic: ${topic}`);
    }
  });

  process.on('SIGINT', () => {
    client.end();
    console.log('[Mock Reset Listener] Stopped.');
    process.exit(0);
  });
});

client.on('message', (topic, message) => {
  console.log(`[Mock Reset Listener] [${new Date().toISOString()}] Received reset packet: ${message.toString()}`);
});

client.on('error', (err) => {
  console.error('[Mock Reset Listener] Error:', err.message);
});
