# Manual: pago a proveedores desde WhatsApp (OPTUS × TilcAI)

Un administrador pide material por WhatsApp, autoriza el pago con su huella y el
proveedor recibe USDC en Stellar. El envío sale de Avalanche y lo ejecuta TilcAI
con el OpenZeppelin Relayer del mismo equipo.

```
WhatsApp (admin) ──"Quiero comprar 50 bolsas de cemento"──▶ optus-agentBE (plantillas)
      ◀── CTA "Autorizar pago" (enlace /autorizar/:id) ──┘
optus-frontend /autorizar/:id ── huella (WebAuthn) ──▶ optus-agentBE verifica la firma
optus-agentBE ── firma EIP-3009 con PRIVATE_KEY_MOCK ──▶ TilcAI (127.0.0.1:8787)
TilcAI ── OZ Relayer (localhost:8080) ──▶ burn en Avalanche ─ CCTP ─▶ mint en Stellar
optus-agentBE ◀── enlaces Snowtrace + Stellar Expert ── TilcAI
WhatsApp (admin) ◀── CTA "Pago a proveedor completado" (monto + enlaces)
```

## 1. Requisitos (una sola vez)

| Pieza | Cómo comprobarlo |
| --- | --- |
| OpenZeppelin Relayer en Docker | `curl http://localhost:8080/api/v1/health` → `OK` |
| Node 24 para TilcAI | `nvm use 24` |
| Admin registrado | Su número debe estar en `companies.whatsapp_admin_phone_ids` o en `company_users` con rol `ADMIN` |
| Tenant de desarrollo | `DEV_TENANT_PHONE_NUMBER_ID` = `phone_number_id` del bot (o vacío) |
| Wallet pagadora | `PRIVATE_KEY_MOCK` en `.env`, con USDC en Avalanche Fuji (faucet: https://faucet.circle.com) |
| Proveedor | `SUPPLIER_STELLAR_ADDRESS` con trustline USDC en Stellar testnet |
| Teléfono | Android con Chrome o iPhone con Safari, y bloqueo de pantalla con huella / Face ID activo |

Variables del flujo en `optus-agentBE/.env` (ver `.env.example`):

```env
WHATSAPP_CONVERSATION_ENGINE='templates'   # sin Gemini: reglas + plantillas
SUPPLIER_AUTH_URL='https://<tu-dominio>.ngrok-free.dev'
SUPPLIER_AUTH_EXTRA_ORIGINS='http://localhost:5173'
TILCAI_API_URL='http://127.0.0.1:8787'
SUPPLIER_CEMENT_UNIT_PRICE_USDC='0.02'     # 50 bolsas = 1.00 USDC
```

## 2. Levantar los servicios (cada vez)

Cuatro terminales en el mismo equipo:

```bash
# 1) TilcAI (API + worker) junto al relayer
cd tilcai/tilcai-infrastructure && nvm use 24 && npm start

# 2) Backend de OPTUS
cd optus/optus-agentBE && npm run start:dev

# 3) Frontend de OPTUS (reenvía /v1 al backend en :3000)
cd optus/optus-frontend && npm run dev

# 4) Un único túnel público hacia el frontend
ngrok http 5173 --url=dot-revealable-telescopically.ngrok-free.dev
```

> El túnel `facilitador` de `~/.config/ngrok/ngrok.yml` usa el mismo dominio apuntando
> al puerto 8080. Si está activo, deténlo antes de abrir el túnel al 5173.

Con un solo túnel se sirven la página `/autorizar/:id`, su API (`/v1/supplier-payments/*`)
y el webhook de WhatsApp (`/v1/webhooks/whatsapp`), porque Vite reenvía `/v1` al backend.

**Webhook de Meta** (Meta Developers → WhatsApp → Configuración):

- Callback URL: `https://dot-revealable-telescopically.ngrok-free.dev/v1/webhooks/whatsapp`
- Verify token: el valor de `WHATSAPP_VERIFY_TOKEN`

**Diagnóstico** (no mueve fondos):

```bash
cd optus/optus-agentBE && npm run supplier:check
```

Debe mostrar `Todo listo`: wallet pagadora, saldo USDC, TilcAI + relayer, trustline del
proveedor y `SUPPLIER_AUTH_URL` en https.

## 3. Hacer el flujo desde WhatsApp

1. **Desde el teléfono del administrador**, escribe al número del bot:

   > Quiero comprar 50 bolsas de cemento

   También entiende: «Necesito 120 bolsas de cemento», «Compra cincuenta bolsas de cemento»,
   «Pedir cemento» (50 por defecto). Un número que no es admin recibe un aviso de que la
   compra requiere un administrador.

2. Llega el mensaje **🔐 Autorización requerida** con la orden (`OC-AAAAMMDD-####`),
   proveedor, cantidad, precio y total, y el botón **Autorizar pago**. El enlace vence en
   15 minutos.

3. Toca **Autorizar pago**. Si ngrok muestra su aviso de «You are about to visit…», toca
   **Visit Site** (solo la primera vez).

4. En la página revisa los datos y toca **Autorizar con huella**:
   - **Primera vez en ese teléfono**: el sistema registra tu huella (passkey) y enseguida
     pide la huella otra vez para firmar la orden. Si el navegador lo pide, toca
     **Firmar con huella** para el segundo paso.
   - **Siguientes veces**: el botón dice **Firmar con huella** y basta un solo escaneo.

5. Llega a WhatsApp **✅ Autorización firmada…** y la página muestra el avance:
   envío desde Avalanche → verificación entre redes → acreditación en Stellar.
   Tarda entre 30 y 60 segundos.

6. Llega **✅ Pago a proveedor completado** (mensaje CTA) con el monto, el proveedor, el
   enlace de **Snowtrace** (envío en Avalanche) y el de **Stellar Expert** (acreditación en
   Stellar). El botón abre Stellar Expert; la página también muestra ambos enlaces.

Para rechazar: **Rechazar orden** → **Toca de nuevo para rechazar**. Llega a WhatsApp que la
orden fue rechazada y no se paga nada.

## 4. Problemas frecuentes

| Síntoma | Causa y solución |
| --- | --- |
| El bot no responde | Revisa el webhook de Meta, `DEV_TENANT_PHONE_NUMBER_ID` y los logs del backend (`Flujo de plantillas activado`). |
| Responde que solo administradores | El número no está como admin de la empresa (paso 1 de requisitos). |
| La página dice que el navegador no permite la huella | Ábrela en Chrome (Android) o Safari (iPhone) y por **https**; los navegadores internos de algunas apps no soportan passkeys. |
| «Se canceló la lectura de huella» | Se cerró el diálogo o pasó el tiempo. Vuelve a tocar el botón. |
| «La solicitud venció» | Pasaron 15 minutos. Escribe de nuevo la compra por WhatsApp. |
| Pago fallido: «el servicio de pagos no está disponible» | TilcAI no corre o el relayer está caído: `npm run supplier:check`. |
| Pago fallido: «saldo insuficiente» | Recarga USDC de Fuji en la wallet pagadora (la dirección sale en `supplier:check`). |
| CTA no llega pero sí un texto | Meta rechazó el interactivo (p. ej. fuera de la ventana de 24 h); el backend reenvía la misma información como texto. |

## 5. Referencia técnica

- Backend: `src/features/supplier-payments/` (plantillas, verificación WebAuthn con
  `node:crypto`, cliente TilcAI, firma EIP-3009 con `viem`). Las órdenes y passkeys se
  guardan en `.data/supplier-payments.json` (fuera de git) y los pagos en curso se retoman
  al reiniciar.
- API para la página: `GET /v1/supplier-payments/:id`, `POST …/webauthn/options`,
  `POST …/webauthn/register`, `POST …/approve`, `POST …/reject`.
- TilcAI: modo `gasless`. OPTUS firma `ReceiveWithAuthorization` (EIP-3009) y TilcAI la
  envía por el relayer `avalanche-fuji-relayer` a `TilcaiCctpRouter`; el mint en Stellar lo
  envía `stellar-example`. La wallet pagadora no gasta AVAX.
- Antes de firmar, OPTUS comprueba que la autorización mueve USDC de Fuji desde su wallet al
  router de TilcAI por el monto aprobado (tope +1 % por fee de CCTP).
