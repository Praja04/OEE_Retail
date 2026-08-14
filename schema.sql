-- SQL script to initialize the oee_d1 table.
-- Make sure the database 'project_utility' exists in your local Laragon MySQL.

USE `project_utility`;

CREATE TABLE IF NOT EXISTS `oee_d1` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `oee_d1` INT NOT NULL COMMENT 'Jumlah mesin hidup dalam menit',
  `ct_productd1` INT NOT NULL,
  `jam` VARCHAR(10) NOT NULL COMMENT 'Format jam (misal 06.00)',
  `machine_ts` DATETIME NOT NULL COMMENT 'Timestamp jam pas dari mesin (YYYY-MM-DD HH:00:00)',
  `saved_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT 'Waktu penyimpanan data ke DB',
  UNIQUE KEY `idx_unique_hour` (`machine_ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
