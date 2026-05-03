const FIRST_NAMES = [
  'Ahmad', 'Budi', 'Rian', 'Kevin', 'Jason', 'Michael', 'David', 'Alex',
  'Daniel', 'Chris', 'Ryan', 'James', 'Adam', 'Bryan', 'Nathan', 'Eric',
  'Siti', 'Dewi', 'Maya', 'Rina', 'Lisa', 'Sarah', 'Anna', 'Jessica',
  'Putri', 'Nurul', 'Ayu', 'Fitri', 'Dina', 'Wulan', 'Rini', 'Yeni'
];

const LAST_NAMES = [
  'Santoso', 'Wijaya', 'Kusuma', 'Prasetyo', 'Suryadi', 'Wibowo',
  'Hermawan', 'Lestari', 'Purnama', 'Hidayat', 'Saputra', 'Gunawan',
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Martinez', 'Wilson', 'Anderson', 'Taylor', 'Thomas'
];

const STREET_TYPES = ['Jl.', 'Jalan', 'Gang', 'Gg.', 'Komplek', 'Perum.'];

const STREET_NAMES = [
  'Sudirman', 'Thamrin', 'Gatot Subroto', 'Rasuna Said', 'Hayam Wuruk',
  'Merdeka', 'Diponegoro', 'Imam Bonjol', 'Teuku Umar', 'Ahmad Yani',
  'Gajah Mada', 'Veteran', 'Pahlawan', 'Pemuda', 'Pattimura',
  'Sisingamangaraja', 'Panglima Polim', 'Wolter Monginsidi', 'Tendean',
  'Kemang Raya', 'Ampera', 'Fatmawati', 'Ciputat Raya', 'Ragunan',
  'Pondok Indah', 'Kebayoran Baru', 'Senayan', 'Kuningan', 'Menteng',
  'Cikini', 'Matraman', 'Otista', 'Kalimalang', 'Bekasi Raya',
  'Buah Batu', 'Soekarno Hatta', 'Riau', 'Braga', 'Pasteur',
  'Dago', 'Cihampelas', 'Setiabudhi', 'Kaliurang', 'Malioboro',
  'Solo', 'Urip Sumoharjo', 'Basuki Rahmat', 'Darmo', 'Rungkut',
  'Semanggi', 'Kebon Jeruk', 'Daan Mogot', 'Pramuka', 'MT Haryono',
];

// Indonesian cities grouped by province with postal code ranges
const CITY_DATA: Array<{ city: string; province: string; postalRange: [number, number] }> = [
  { city: 'Jakarta Pusat',   province: 'DKI Jakarta',        postalRange: [10110, 10740] },
  { city: 'Jakarta Selatan', province: 'DKI Jakarta',        postalRange: [12110, 12960] },
  { city: 'Jakarta Barat',   province: 'DKI Jakarta',        postalRange: [11110, 11750] },
  { city: 'Jakarta Timur',   province: 'DKI Jakarta',        postalRange: [13110, 13960] },
  { city: 'Jakarta Utara',   province: 'DKI Jakarta',        postalRange: [14110, 14460] },
  { city: 'Bandung',         province: 'Jawa Barat',         postalRange: [40111, 40614] },
  { city: 'Bekasi',          province: 'Jawa Barat',         postalRange: [17111, 17520] },
  { city: 'Depok',           province: 'Jawa Barat',         postalRange: [16411, 16519] },
  { city: 'Bogor',           province: 'Jawa Barat',         postalRange: [16111, 16169] },
  { city: 'Tangerang',       province: 'Banten',             postalRange: [15111, 15810] },
  { city: 'Tangerang Selatan', province: 'Banten',           postalRange: [15111, 15414] },
  { city: 'Surabaya',        province: 'Jawa Timur',         postalRange: [60111, 60299] },
  { city: 'Malang',          province: 'Jawa Timur',         postalRange: [65111, 65149] },
  { city: 'Sidoarjo',        province: 'Jawa Timur',         postalRange: [61211, 61271] },
  { city: 'Yogyakarta',      province: 'DI Yogyakarta',      postalRange: [55111, 55581] },
  { city: 'Sleman',          province: 'DI Yogyakarta',      postalRange: [55511, 55584] },
  { city: 'Semarang',        province: 'Jawa Tengah',        postalRange: [50111, 50279] },
  { city: 'Solo',            province: 'Jawa Tengah',        postalRange: [57111, 57176] },
  { city: 'Medan',           province: 'Sumatera Utara',     postalRange: [20111, 20241] },
  { city: 'Deli Serdang',    province: 'Sumatera Utara',     postalRange: [20311, 20372] },
  { city: 'Makassar',        province: 'Sulawesi Selatan',   postalRange: [90111, 90245] },
  { city: 'Palembang',       province: 'Sumatera Selatan',   postalRange: [30111, 30169] },
  { city: 'Pekanbaru',       province: 'Riau',               postalRange: [28111, 28294] },
  { city: 'Batam',           province: 'Kepulauan Riau',     postalRange: [29411, 29469] },
  { city: 'Denpasar',        province: 'Bali',               postalRange: [80111, 80239] },
  { city: 'Badung',          province: 'Bali',               postalRange: [80351, 80473] },
];

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateRandomName(): string {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  return `${first} ${last}`;
}

export interface RandomAddress {
  line1: string;
  city: string;
  province: string;
  postalCode: string;
}

export function generateRandomAddress(): RandomAddress {
  const streetType = pick(STREET_TYPES);
  const streetName = pick(STREET_NAMES);
  const streetNo = rand(1, 250);
  // Sometimes add a block/unit suffix for variety
  const suffix = Math.random() < 0.4 ? ` No. ${streetNo}` : ` ${streetNo}`;
  const line1 = `${streetType} ${streetName}${suffix}`;

  const cityData = pick(CITY_DATA);
  const postalCode = String(rand(cityData.postalRange[0], cityData.postalRange[1]));

  return {
    line1,
    city: cityData.city,
    province: cityData.province,
    postalCode,
  };
}

export function generateRandomBirthdate(): { month: string; day: string; year: string } {
  const year = String(Math.floor(Math.random() * 11) + 1990);
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
  const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
  return { month, day, year };
}

export function generateRandomAge(): string {
  return String(Math.floor(Math.random() * 11) + 20);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
