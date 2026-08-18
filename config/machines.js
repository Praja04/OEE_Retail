require('dotenv').config();

/**
 * Normalizes a machine ID string (e.g. 'D1' or 'd10') into a standardized machine configuration object.
 */
function getMachineConfig(machineId) {
  const cleanId = String(machineId).trim().toUpperCase();
  const cleanLower = cleanId.toLowerCase();

  return {
    id: cleanId,
    topicSub: process.env[`MQTT_TOPIC_SUB_${cleanId}`] || `OEE_${cleanId}`,
    topicPub: process.env[`MQTT_TOPIC_PUB_${cleanId}`] || `RST_${cleanId}`,
    tableName: process.env[`DB_TABLE_${cleanId}`] || `oee_${cleanLower}`,
    oeeField: `oee_${cleanLower}`,
    productField: `ct_product${cleanLower}`,
    resetField: `RST_${cleanId}`
  };
}

/**
 * Returns an array of machine configuration objects for all active machines defined in process.env.ENABLED_MACHINES.
 * Default: ['D1', 'D10']
 */
function getActiveMachines() {
  const rawList = process.env.ENABLED_MACHINES || 'D1,D10';
  const machineIds = rawList
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  // Remove duplicates while maintaining order
  const uniqueIds = [...new Set(machineIds)];

  return uniqueIds.map(getMachineConfig);
}

module.exports = {
  getMachineConfig,
  getActiveMachines
};
