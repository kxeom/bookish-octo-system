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

export function generateRandomName(): string {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${first} ${last}`;
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
