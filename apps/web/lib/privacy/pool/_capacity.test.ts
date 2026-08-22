import { describe, it } from 'vitest';
import { estimateShieldPrefundLamports, findPoolV3, shieldValueLamports } from './denominatedPool';

describe('capacite du flotteur', () => {
  it('calcule depuis les fonctions que le garde-fou utilise', async () => {
    const pool = findPoolV3('SOL', 1)!;
    const worst = estimateShieldPrefundLamports(pool); // pire tirage de gigue
    const value = shieldValueLamports(pool);
    const RELAY_FEE = 5_000;
    const r = await fetch('https://protocol-01.dev/api/relay-to-buyer');
    const t = (await r.json()) as { funderLamports: number };
    const float = t.funderLamports;

    const need = worst + RELAY_FEE;
    const net = value + 480; // ce que le flotteur perd NET par depot (mesure: 1.003480)
    /* eslint-disable no-console */
    console.log(`\n  flotteur                 ${(float / 1e9).toFixed(6)} SOL`);
    console.log(`  pre-fund pire cas        ${(worst / 1e9).toFixed(6)} SOL  (+${RELAY_FEE} de frais relais)`);
    console.log(`  il faut donc             ${(need / 1e9).toFixed(6)} SOL immobilises par depot`);
    console.log(`  perte NETTE par depot    ${(net / 1e9).toFixed(6)} SOL  (la rente revient, la valeur va a la caisse)`);
    console.log(`\n  SIMULTANES  ${Math.floor(float / need)}`);
    let bal = float, n = 0;
    while (bal >= need) { bal -= net; n++; }
    console.log(`  A LA SUITE  ${n}  (sans reversement ; le ${n + 1}e est refuse a ${(bal / 1e9).toFixed(4)} SOL)`);
    console.log(`  AVEC reversement groupe : illimite — le flotteur ne perd que ce que la caisse detient\n`);
  });
});
