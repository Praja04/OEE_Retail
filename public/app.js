document.addEventListener('DOMContentLoaded', () => {
  console.log('[OEE Retail UI] Dynamic Dashboard initialized.');

  // Initialize DOM Elements
  const clockEl = document.getElementById('clock-wib');
  const countdownTextEl = document.getElementById('countdown-text');
  const countdownBarEl = document.getElementById('countdown-bar');
  const jamBadgeEl = document.getElementById('current-jam-badge');
  const nextResetTimeLabel = document.getElementById('next-reset-time-label');
  const btnReset = document.getElementById('btn-manual-reset');
  const btnRefresh = document.getElementById('btn-refresh-db');

  // KPI Card 1 (OEE Uptime)
  const valOeeEl = document.getElementById('val-oee');
  const valPctEl = document.getElementById('oee-pct');
  const valEfficiencyEl = document.getElementById('val-efficiency');
  const oeeStatusBadge = document.getElementById('oee-status-badge');
  const gaugeBarEl = document.getElementById('oee-gauge-bar');

  // KPI Card 2 (Total Counter)
  const valProductEl = document.getElementById('val-product');
  const valSpeedEl = document.getElementById('val-speed');
  const valTargetPctEl = document.getElementById('val-target-pct');

  // KPI Card 3 (Downtime)
  const valStopEl = document.getElementById('val-stop');
  const downtimeIconBox = document.getElementById('downtime-icon-box');
  const downtimeStatusContainer = document.getElementById('downtime-status-container');
  const downtimeStatusText = document.getElementById('downtime-status-text');
  const downtimeShiftStatus = document.getElementById('downtime-shift-status');
  const downtimeOperationBadge = document.getElementById('downtime-operation-badge');

  // Database Table Body
  const dbTableBody = document.getElementById('db-table-body');

  // State cache for live MQTT data
  let latestData = {
    oee: 0,
    product: 0,
    stopShift: 0,
    hasData: false
  };

  // Chart setup
  let oeeChart;
  initChart();

  // Helper to extract WIB time components
  function getWibComponents() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    const parts = formatter.formatToParts(now);
    const getPart = (type) => parts.find(p => p.type === type)?.value || '00';
    
    let hh = parseInt(getPart('hour'), 10);
    if (isNaN(hh)) hh = now.getHours();
    const mm = parseInt(getPart('minute'), 10) || now.getMinutes();
    const ss = parseInt(getPart('second'), 10) || now.getSeconds();

    return { hh, mm, ss };
  }

  // 1. WIB Clock & Countdown Ticker
  function updateWibClockAndCountdown() {
    const { hh, mm, ss } = getWibComponents();

    const hhPad = String(hh).padStart(2, '0');
    const mmPad = String(mm).padStart(2, '0');
    const ssPad = String(ss).padStart(2, '0');

    if (clockEl) {
      clockEl.textContent = `${hhPad}:${mmPad}:${ssPad} WIB`;
    }

    if (jamBadgeEl) {
      jamBadgeEl.textContent = `${hhPad}.00`;
    }

    const nextHh = (hh + 1) % 24;
    const nextHhPad = String(nextHh).padStart(2, '0');
    if (nextResetTimeLabel) {
      nextResetTimeLabel.textContent = `Pukul ${nextHhPad}:00:00 WIB`;
    }

    // Countdown to next top of hour (HH:00:00)
    const remMin = 59 - mm;
    const remSec = 59 - ss;
    const remMinPad = String(remMin).padStart(2, '0');
    const remSecPad = String(remSec).padStart(2, '0');

    if (countdownTextEl) {
      countdownTextEl.textContent = `00:${remMinPad}:${remSecPad}`;
    }

    // Progress Bar (0% at minute 00, 100% at minute 59)
    const elapsedSeconds = mm * 60 + ss;
    const pctElapsed = Math.min(100, Math.max(0, (elapsedSeconds / 3600) * 100));
    if (countdownBarEl) {
      countdownBarEl.style.width = `${pctElapsed.toFixed(1)}%`;
    }

    // Continuously recalculate real-time KPI metrics (Downtime, Efficiency, Speed)
    updateCalculatedMetrics(mm);
  }

  // 2. Real-time Metric Calculations (Downtime = Elapsed Minutes - Uptime)
  function updateCalculatedMetrics(elapsedMinutes) {
    const oee = latestData.oee;
    const product = latestData.product;

    // A. Downtime Calculation: Jam Sekarang (elapsed minutes) minus Uptime
    // Example: at 09:50, elapsed = 50 min. If uptime (oee) = 37 min -> downtime = 50 - 37 = 13 min
    const downtime = Math.max(0, elapsedMinutes - Math.min(elapsedMinutes, oee));

    if (valStopEl) {
      valStopEl.innerHTML = `${downtime}<span class="kpi-unit">min</span>`;
    }

    if (downtime > 0) {
      if (valStopEl) valStopEl.style.color = '#fca5a5';
      if (downtimeIconBox) {
        downtimeIconBox.style.color = 'var(--rose-accent)';
        downtimeIconBox.style.borderColor = 'rgba(244, 63, 94, 0.3)';
      }
      if (downtimeStatusContainer) downtimeStatusContainer.style.color = 'var(--rose-accent)';
      if (downtimeStatusText) {
        downtimeStatusText.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px; height: 14px; vertical-align: middle;"></i> ${downtime} Menit Downtime`;
      }
      if (downtimeShiftStatus) downtimeShiftStatus.textContent = 'Status Shift: Downtime Terdeteksi';
      if (downtimeOperationBadge) {
        downtimeOperationBadge.innerHTML = `<span style="color: var(--rose-accent);">Perlu Perhatian</span>`;
      }
    } else {
      if (valStopEl) valStopEl.style.color = '#6ee7b7';
      if (downtimeIconBox) {
        downtimeIconBox.style.color = 'var(--emerald-accent)';
        downtimeIconBox.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      }
      if (downtimeStatusContainer) downtimeStatusContainer.style.color = 'var(--emerald-accent)';
      if (downtimeStatusText) {
        downtimeStatusText.innerHTML = `<i data-lucide="check-circle-2" style="width: 14px; height: 14px; vertical-align: middle;"></i> Tidak ada Downtime`;
      }
      if (downtimeShiftStatus) downtimeShiftStatus.textContent = 'Status Shift: Berjalan';
      if (downtimeOperationBadge) {
        downtimeOperationBadge.innerHTML = `<span style="color: var(--emerald-accent);">Smooth Operation</span>`;
      }
    }

    // B. OEE Efficiency Calculation
    let efficiency = 100;
    if (elapsedMinutes > 0) {
      efficiency = Math.min(100, Math.round((oee / elapsedMinutes) * 100));
    }
    if (valEfficiencyEl) {
      valEfficiencyEl.innerHTML = `<i data-lucide="trending-up" style="width: 14px; height: 14px; vertical-align: middle;"></i> ${efficiency}% Efficiency`;
    }

    // C. Production Speed & Target Shift Percentage
    // Output Jam Ini = Total Counter Saat Ini - Counter Jam Sebelumya (di DB)
    const previousHourCounter = latestData.previousHourCounter || 0;
    let currentHourOutput = product;
    if (previousHourCounter > 0 && product >= previousHourCounter) {
      currentHourOutput = product - previousHourCounter;
    }

    if (valSpeedEl) {
      let speedMin = '0.0';
      if (oee > 0) {
        speedMin = (currentHourOutput / oee).toFixed(1);
      }
      valSpeedEl.innerHTML = `Kecepatan: ~${speedMin} pcs / min (Jam ini: +${currentHourOutput.toLocaleString()} pcs)`;
    }

    if (valTargetPctEl) {
      const targetPct = Math.min(100, ((product / 30000) * 100)).toFixed(1);
      valTargetPctEl.textContent = `${targetPct}% Target`;
    }

    // Refresh Lucide icons if updated dynamically
    if (window.lucide) lucide.createIcons();
  }

  setInterval(updateWibClockAndCountdown, 1000);
  updateWibClockAndCountdown();

  // 3. Initialize Chart.js
  function initChart() {
    const ctx = document.getElementById('oeeChart')?.getContext('2d');
    if (!ctx) return;

    oeeChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['06.00', '07.00', '08.00', '09.00', '10.00', '11.00', '12.00', '13.00', '14.00'],
        datasets: [
          {
            label: 'OEE Uptime (Menit)',
            data: [0, 0, 0, 0, 0, 0, 0, 0, 0],
            backgroundColor: 'rgba(6, 182, 212, 0.5)',
            borderColor: '#06b6d4',
            borderWidth: 2,
            borderRadius: 6,
            yAxisID: 'y'
          },
          {
            label: 'Output Counter (Pcs)',
            data: [0, 0, 0, 0, 0, 0, 0, 0, 0],
            type: 'line',
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            borderWidth: 3,
            pointBackgroundColor: '#10b981',
            pointRadius: 4,
            tension: 0.3,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: '#94a3b8',
              font: { family: 'Outfit', size: 12 }
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#94a3b8' }
          },
          y: {
            type: 'linear',
            position: 'left',
            max: 60,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#06b6d4' },
            title: { display: true, text: 'Menit Aktif (max 60)', color: '#06b6d4' }
          },
          y1: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { color: '#10b981' },
            title: { display: true, text: 'Counter Pcs', color: '#10b981' }
          }
        }
      }
    });
  }

  // 4. Update Gauge Ring
  function updateGaugeRing(minutes) {
    const maxMin = 60;
    const pct = Math.min(100, Math.max(0, (minutes / maxMin) * 100));
    
    // Circle circumference = 2 * PI * r (r=38) = 238.76
    const circumference = 238.76;
    const offset = circumference - (pct / 100) * circumference;

    if (gaugeBarEl) {
      gaugeBarEl.style.strokeDasharray = circumference;
      gaugeBarEl.style.strokeDashoffset = offset;
    }
    if (valPctEl) {
      valPctEl.textContent = `${Math.round(pct)}%`;
    }
  }

  // 5. API Data Fetching
  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error('API offline');
      const data = await res.json();

      if (data && data.lastKnownData) {
        latestData.oee = data.lastKnownData.oee_d1 ?? 0;
        latestData.product = data.lastKnownData.ct_productd1 ?? 0;
        latestData.stopShift = data.lastKnownData.stop_shiftd1 ?? 0;
        latestData.previousHourCounter = data.previousHourCounter ?? 0;
        latestData.peakOee = data.peakOeeThisHour ?? 0;
        latestData.peakProduct = data.peakProductThisHour ?? 0;
        latestData.hasData = true;

        const effectiveOee = (latestData.oee === 0 && latestData.peakOee > 0) ? latestData.peakOee : latestData.oee;
        const effectiveProduct = (latestData.product === 0 && latestData.peakProduct > 0) ? latestData.peakProduct : latestData.product;

        if (valOeeEl) valOeeEl.innerHTML = `${effectiveOee}<span class="kpi-unit">min</span>`;
        if (valProductEl) valProductEl.innerHTML = `${effectiveProduct.toLocaleString()}<span class="kpi-unit">pcs</span>`;

        updateGaugeRing(effectiveOee);

        const { mm } = getWibComponents();
        updateCalculatedMetrics(mm);
      }
    } catch (err) {
      console.warn('[API] Status fetch error:', err.message);
    }
  }

  async function fetchHistory() {
    try {
      const res = await fetch('/api/history');
      if (!res.ok) throw new Error('DB API offline');
      const rows = await res.json();

      if (Array.isArray(rows) && dbTableBody) {
        if (rows.length > 0) {
          dbTableBody.innerHTML = rows.map(r => `
            <tr>
              <td>${r.id}</td>
              <td><span class="badge-jam">${r.jam}</span></td>
              <td>${r.oee_d1} min</td>
              <td>${Number(r.ct_productd1).toLocaleString()} pcs</td>
            </tr>
          `).join('');

          // Update Chart dynamically with history DB records
          const sortedRows = [...rows].reverse();
          const labels = sortedRows.map(r => r.jam);
          const oeeData = sortedRows.map(r => r.oee_d1);
          const productData = sortedRows.map(r => r.ct_productd1);

          if (oeeChart) {
            oeeChart.data.labels = labels;
            oeeChart.data.datasets[0].data = oeeData;
            oeeChart.data.datasets[1].data = productData;
            oeeChart.update();
          }
        } else {
          dbTableBody.innerHTML = `
            <tr>
              <td colspan="4" style="text-align: center; color: var(--text-dim);">Belum ada log data hourly di database.</td>
            </tr>
          `;
        }
      }
    } catch (err) {
      console.warn('[API] History fetch error:', err.message);
    }
  }

  // 6. Manual Reset Button Event
  if (btnReset) {
    btnReset.addEventListener('click', async () => {
      btnReset.disabled = true;
      btnReset.style.opacity = '0.7';
      const originalText = btnReset.innerHTML;
      btnReset.innerHTML = `<i data-lucide="loader-2" class="spin"></i> SENDING PULSE...`;

      try {
        const res = await fetch('/api/reset', { method: 'POST' });
        const result = await res.json();
        
        alert(`✅ Sinyal Reset RST_D1 Terkirim!\n\nPayload 1 (ON) -> Delay 500ms -> Payload 0 (OFF)\nStatus: ${result.message || 'Sukses'}`);
      } catch (err) {
        alert('⚠️ Sinyal Reset dikirim via simulasi MQTT.');
      } finally {
        setTimeout(() => {
          btnReset.disabled = false;
          btnReset.style.opacity = '1';
          btnReset.innerHTML = originalText;
          if (window.lucide) lucide.createIcons();
        }, 1000);
      }
    });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      fetchHistory();
      fetchStatus();
    });
  }

  // Polling status
  setInterval(fetchStatus, 3000);
  fetchStatus();
  fetchHistory();
});
