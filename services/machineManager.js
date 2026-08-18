/**
 * In-memory state manager for tracking telemetry and peak counters for all configured machines independently.
 */
class MachineManager {
  constructor() {
    this.machineStates = new Map();
  }

  /**
   * Initializes state objects for all enabled machines.
   */
  initMachines(machines = []) {
    for (const machine of machines) {
      this.machineStates.set(machine.id, {
        config: machine,
        lastKnownData: {
          oee: null,
          product: null,
          stop: null,
          lastReceivedAt: null
        },
        peakOeeThisHour: 0,
        peakProductThisHour: 0,
        lastProcessedHourTimestamp: null
      });
      console.log(`[STATE] State tracking initialized for Machine ${machine.id}`);
    }
  }

  /**
   * Updates state telemetry for a specific machine when an MQTT message arrives.
   */
  updateTelemetry(machineConfig, payload) {
    const state = this.machineStates.get(machineConfig.id);
    if (!state) return;

    try {
      const d = payload?.d || payload;
      
      // Extract OEE minute value (supports array [ 2 ] or integer)
      const rawOee = d?.[machineConfig.topicSub] ?? d?.[machineConfig.oeeField] ?? d?.[machineConfig.topicSub.toUpperCase()];
      let newOee = state.lastKnownData.oee;
      if (rawOee !== undefined && rawOee !== null) {
        newOee = Array.isArray(rawOee) ? (parseInt(rawOee[0]) || 0) : (parseInt(rawOee) || 0);
      }

      // Extract CT Product counter value (supports array [ 10402 ] or integer)
      const rawProduct = d?.[`CT_PRODUCT${machineConfig.id}`] ?? d?.[machineConfig.productField] ?? d?.[`CT_PRODUCT${machineConfig.id.toUpperCase()}`];
      let newProduct = state.lastKnownData.product;
      if (rawProduct !== undefined && rawProduct !== null) {
        newProduct = Array.isArray(rawProduct) ? (parseInt(rawProduct[0]) || 0) : (parseInt(rawProduct) || 0);
      }

      // Extract Stop Shift status
      const rawStop = d?.[`STOP_SHIFT${machineConfig.id}`] ?? d?.[`stop_shift${machineConfig.id.toLowerCase()}`];
      let newStop = state.lastKnownData.stop;
      if (rawStop !== undefined && rawStop !== null) {
        newStop = Array.isArray(rawStop) ? (parseInt(rawStop[0]) || 0) : (parseInt(rawStop) || 0);
      }

      // Update Peak Trackers
      if (newOee !== null && newOee > 0 && newOee >= state.peakOeeThisHour) {
        state.peakOeeThisHour = newOee;
      }
      if (newProduct !== null && newProduct > 0 && newProduct >= state.peakProductThisHour) {
        state.peakProductThisHour = newProduct;
      }

      state.lastKnownData = {
        oee: newOee,
        product: newProduct,
        stop: newStop,
        lastReceivedAt: new Date()
      };

    } catch (err) {
      console.error(`[STATE] Error updating telemetry for Machine ${machineConfig.id}:`, err.message);
    }
  }

  getMachineState(machineId) {
    return this.machineStates.get(machineId);
  }

  getAllStates() {
    return Array.from(this.machineStates.values());
  }

  resetPeakTrackers(machineId) {
    const state = this.machineStates.get(machineId);
    if (state) {
      state.peakOeeThisHour = 0;
      state.peakProductThisHour = 0;
    }
  }
}

module.exports = new MachineManager();
