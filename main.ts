// Titik masuk forge: jembatan antara proses ini dan environment make.fun.
//
// Kontraknya sederhana dan tidak bisa ditawar:
//   - MAKEFUN_ENV_URL harus ada; tanpa env tidak ada trial, jadi keluar dengan kode 1.
//   - Server mendengarkan di port ephemeral (listen(0)); port 8080 milik env.
//   - Port yang terikat dilaporkan lewat POST $MAKEFUN_ENV_URL/register {"port": N}.
//     200 berarti diterima, 409 berarti register pertama sudah menang (bukan urusan
//     proses ini), 400/405 adalah kesalahan kontrak yang fatal, sisanya dicoba lagi.
//   - Setelah itu GET $MAKEFUN_ENV_URL/done dipoll sampai menjawab {"done": true};
//     proses tidak boleh keluar sebelum env menyatakan selesai.
//   - Terakhir server ditutup dan proses keluar dengan kode 0.
//
// Semua logika HTTP forge ada di app.ts; berkas ini hanya mengurus masa hidup proses.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  console.error('[forge] MAKEFUN_ENV_URL belum diset; tidak ada env untuk registrasi');
  process.exit(1);
}

const TIMEOUT_MS = 30_000; // batas waktu satu percobaan request ke env
const BACKOFF_MIN_MS = 250; // jeda awal antar percobaan
const BACKOFF_MAX_MS = 2_000; // jeda terpanjang antar percobaan

function jeda(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Jeda setelah percobaan ke-n gagal: naik eksponensial dari BACKOFF_MIN_MS, dibatasi BACKOFF_MAX_MS.
function jedaSetelah(n: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(n, 8));
}

// Laporkan port ke env; ulangi selama env belum siap, berhenti pada jawaban yang final.
async function daftarkanPort(port: number): Promise<void> {
  for (let n = 0; ; n += 1) {
    let fatal: Error | null = null;
    try {
      const res = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        fatal = new Error(`register ditolak env: HTTP ${res.status}: ${await res.text()}`);
      }
    } catch {
      // Gagal jaringan atau timeout: env mungkin masih mulai; coba lagi di bawah.
    }
    if (fatal !== null) throw fatal;
    await jeda(jedaSetelah(n));
  }
}

// Poll /done sampai env menjawab done=true; tidak pernah kembali sebelum itu.
async function tungguSelesai(): Promise<void> {
  for (let n = 0; ; n += 1) {
    try {
      const res = await fetch(`${envBase}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Env belum menjawab; anggap belum selesai dan poll lagi.
    }
    await jeda(jedaSetelah(n));
  }
}

async function jalankan(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('server tidak terikat pada port TCP ephemeral');
  }
  console.log(`[forge] mendengarkan di port ${addr.port}`);

  await daftarkanPort(addr.port);
  console.log('[forge] terdaftar; menunggu env menyatakan selesai');

  await tungguSelesai();
  server.close();
  console.log('[forge] selesai');
}

try {
  await jalankan();
  process.exit(0);
} catch (err) {
  console.error(`[forge] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
