# 📘 Panduan Sederhana: Bagaimana Data Mesin Dicatat & Disimpan

Dokumen ini menjelaskan dengan bahasa yang mudah dipahami tentang bagaimana data produksi dari **Mesin Kemasan (D1)** otomatis dicatat, dijaga dari kehilangan, dan ditampilkan di layar monitor.

---

## 💡 Analogi Sederhana

Bayangkan sistem ini bekerja seperti **Kasir Toko yang Disiplin**:
1. **Mesin Kemasan** = Mesin kasir yang menghitung barang terjual per jam.
2. **Server Aplikasi** = Asisten yang selalu mencatat dan mengingat angka tertinggi.
3. **Database** = Buku Besar / Brankas yang menyimpan catatan permanen.
4. **Layar Dashboard** = Papan Pengumuman untuk melihat hasil produksi secara langsung.

---

## 🔄 ALUR KESELURUHAN DATA: DARI MESIN/PLC HINGGA DATABASE

```
================================================================───────────────────
      DIAGRAM ALUR DATA LENGKAP (PLC ──> MQTT ──> DUAL-LEVEL VERIFICATION ──> DB)
================================================================───────────────────

 ┌───────────────────────────────────────────────────────────────────────────────┐
 │  LANGKAH 1: PROSES RUNNING MESIN DI PABRIK (SETIAP DETIK)                     │
 └───────────────────────────────────────────────────────────────────────────────┘
   • PLC Mesin Kemasan (D1) menghitung durasi jalan: OEE_D1 (menit).
   • PLC mengirim data telemetry secara berkala via MQTT Broker:
     Topik: OEE_D1 | Payload: { "d": { "OEE_D1": [54], "CT_PRODUCTD1": [26500] } }
                                     │
                                     ▼
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │  LANGKAH 2: PENERIMAAN & MEMORY TRACKING SERVER (IN-MEMORY CACHE)             │
 └───────────────────────────────────────────────────────────────────────────────┘
   • Server Node.js menerima data MQTT dan menyimpannya di memory (Cache).
   • Peak Tracker mencatat nilai tertinggi jam ini (misal peakOeeThisHour = 54).
   • Mencegah data hilang walaupun koneksi terputus mendadak sebelum jam pas.
                                     │
                                     ▼
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │  LANGKAH 3: EXECUTION HOURLY PROCESS (JAM PAS - Misal 12.00.00 WIB)           │
 └───────────────────────────────────────────────────────────────────────────────┘
   1. [DB TRANSACTION START] 
      ├── Server membuka Transaksi Database (START TRANSACTION).
      └── Server membuat DRAFT SIMPAN sementara (INSERT INTO oee_d1).

   2. [RESET PULSE - LEVEL 1 CHECK: MQTT QoS 1 Network Ack]
      ├── Server mempublish sinyal Reset Pulse ke Mesin: Topik RST_D1 (1 -> 500ms -> 0).
      └── Jika Broker mati/Network Error ──> LEVEL 1 FAILED ──> ROLLBACK DB! (Batal Simpan)

   3. [VERIFIKASI HARWARE PLC - LEVEL 2 CHECK: Counter Reset Verification]
      ├── Server menunggu telemetry balasan dari PLC dalam 2.5 detik.
      ├── Server memastikan nilai OEE_D1 dari PLC sudah reset ke 0 (OEE_D1 <= 2).
      └── Jika PLC TIDAK mereset counter (masih 54) ──> LEVEL 2 FAILED ──> ROLLBACK DB! (Batal Simpan)

   4. [DECISION AKHIR: COMMIT ATAU ROLLBACK]
      ├── ✅ JIKA LEVEL 1 & LEVEL 2 BERHASIL (PASSED):
      │    ├── Database melakukan COMMIT (Data resmi & permanen disimpan di DB)
      │    └── Peak Tracker di-reset ke 0 untuk memulai jam baru.
      │
      └── ❌ JIKA LEVEL 1 ATAU LEVEL 2 GAGAL (FAILED):
           ├── Database melakukan ROLLBACK (Batal simpan / Undo Insert)
           └── Peak Tracker dipertahankan (Kalkulasi PLC berlanjut 54 -> 110 min).
                                     │
                                     ▼
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │  LANGKAH 4: DISPLAY REAL-TIME DASHBOARD (MONITOR MONITORING)                 │
 └───────────────────────────────────────────────────────────────────────────────┘
   • Web UI / Dashboard meng-update grafik 8 jam terakhir dari Database.
   • Menampilkan Uptime, Kecepatan Produksi (pcs/min), & Downtime real-time.
```

---

### **Detail 2 Tingkat Verifikasi Reset (Dual-Level Verification)**

| Tingkat Verifikasi | Nama Verifikasi | Cara Kerja | Penanganan Jika Gagal |
| :--- | :--- | :--- | :--- |
| **Level 1** | **Network Delivery Ack (QoS 1)** | Memastikan sinyal reset `RST_D1` diterima oleh MQTT Broker tanpa error koneksi. | **ROLLBACK DB**: Batalkan penyimpanan data ke DB. |
| **Level 2** | **PLC Hardware Feedback** | Memastikan counter fisik PLC `OEE_D1` benar-benar berubah menjadi **`0`** ($\le 2$ min). | **ROLLBACK DB**: Batalkan penyimpanan data ke DB. Counter PLC dibiarkan berakumulasi (54 $\rightarrow$ 110 min). |

---

## 🌟 Keuntungan Bagi Operasional Pabrik

| Masalah Dulu | Solusi Sistem Sekarang |
| :--- | :--- |
| ❌ Operator harus catat manual tiap jam | ✅ **Otomatis 100%** tanpa perlu dicatat manual |
| ❌ Jika reset gagal, data di DB jadi rusak/ganda | ✅ **Dual-Level Verification**: Hanya di-COMMIT ke DB jika sinyal reset & konfirmasi PLC **100% Valid** |
| ❌ Suka ada data ganda di jam yang sama | ✅ **Rapi**: 1 Jam pas hanya punya 1 catatan di database |
| ❌ Hitungan kecepatan tidak akurat | ✅ **Presisi**: Kecepatan dihitung murni dari hasil jam berjalan |
