/**
 * Diagnóstico del flujo de pago a proveedores (OPTUS → TilcAI → OZ Relayer).
 *
 *   npm run supplier:check
 *
 * Verifica: wallet pagadora (PRIVATE_KEY_MOCK, solo imprime la dirección),
 * saldo USDC en Avalanche Fuji, API de TilcAI + relayer, y la cuenta Stellar
 * del proveedor (trustline USDC). No mueve fondos.
 */
require('dotenv').config();
const { createPublicClient, erc20Abi, formatUnits, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { avalancheFuji } = require('viem/chains');

const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const env = (key, fallback = '') =>
  String(process.env[key] ?? '')
    .replace(/^﻿|﻿$/g, '')
    .trim()
    .replace(/^['"]|['"]$/g, '') || fallback;

let failures = 0;
const ok = (label, detail = '') => console.log(`PASS  ${label}${detail ? `  -> ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failures++;
  console.log(`FAIL  ${label}${detail ? `  -> ${detail}` : ''}`);
};

async function main() {
  const tilcaiUrl = env('TILCAI_API_URL', 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const supplier = env('SUPPLIER_STELLAR_ADDRESS', 'GDSWUJH6K3HRNJNSNNFB5FZZBGVYIEG4LZMDORLS7R32LIJBO2XWJ4RD');
  const unitPrice = env('SUPPLIER_CEMENT_UNIT_PRICE_USDC', '0.02');
  const authUrl = env('SUPPLIER_AUTH_URL', 'http://localhost:5173');

  // 1. Wallet pagadora
  let account = null;
  const raw = env('PRIVATE_KEY_MOCK');
  if (!raw) fail('PRIVATE_KEY_MOCK configurada');
  else {
    try {
      account = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`);
      ok('wallet pagadora', account.address);
    } catch {
      fail('PRIVATE_KEY_MOCK es una clave EVM válida');
    }
  }

  // 2. Saldo USDC en Fuji
  if (account) {
    try {
      const client = createPublicClient({
        chain: avalancheFuji,
        transport: http(env('AVALANCHE_FUJI_RPC_URL', 'https://api.avax-test.network/ext/bc/C/rpc')),
      });
      const balance = await client.readContract({
        address: FUJI_USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      const fifty = Math.round(Number(unitPrice) * 50 * 1e6);
      const label = `saldo USDC en Avalanche Fuji (50 bolsas = ${(fifty / 1e6).toFixed(2)} USDC)`;
      (balance >= BigInt(fifty) ? ok : fail)(label, `${formatUnits(balance, 6)} USDC`);
    } catch (error) {
      fail('saldo USDC en Avalanche Fuji', error.message);
    }
  }

  // 3. TilcAI + relayer
  try {
    const health = await fetch(`${tilcaiUrl}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    (health.ok ? ok : fail)(`TilcAI ${tilcaiUrl}/health`, `relayer ${health.relayer}`);
    if (health.relayer !== 'up') fail('OpenZeppelin Relayer arriba');
    const headers = env('TILCAI_API_KEY') ? { authorization: `Bearer ${env('TILCAI_API_KEY')}` } : {};
    const routes = await fetch(`${tilcaiUrl}/v1/routes`, { headers, signal: AbortSignal.timeout(5000) });
    (routes.ok ? ok : fail)('TilcAI acepta las llamadas de OPTUS', `HTTP ${routes.status}`);
  } catch (error) {
    fail(`TilcAI ${tilcaiUrl}`, `no responde (${error.message}); ¿corre "npm start" en tilcai-infrastructure?`);
  }

  // 4. Cuenta Stellar del proveedor
  try {
    const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${supplier}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) fail('cuenta Stellar del proveedor existe', `${supplier} HTTP ${res.status}`);
    else {
      const account = await res.json();
      const usdc = account.balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER);
      (usdc && usdc.is_authorized !== false ? ok : fail)('proveedor con trustline USDC', `${supplier} saldo ${usdc?.balance ?? '-'}`);
    }
  } catch (error) {
    fail('cuenta Stellar del proveedor', error.message);
  }

  // 5. Enlace de autorización
  try {
    const url = new URL(authUrl);
    const secure = url.protocol === 'https:' || url.hostname === 'localhost';
    (secure ? ok : fail)('SUPPLIER_AUTH_URL apta para WebAuthn (https)', `${url.origin}/autorizar/:id`);
  } catch {
    fail('SUPPLIER_AUTH_URL es una URL', authUrl);
  }

  console.log(failures ? `\n${failures} comprobación(es) fallaron` : '\nTodo listo');
  process.exit(failures ? 1 : 0);
}

void main();
