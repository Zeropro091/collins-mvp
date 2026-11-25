# Collins MVP — local

Frontend asli dari `venelrangga288-arch/collins` + backend sendiri. Semua lokal, port **5090**.

## Jalanin

```bash
node server.js          # atau double-click start.bat
```

Buka http://localhost:5090 → otomatis ke `/login.html` → Daftar / Masuk → workstation.

## Yang jalan

| Fitur | Endpoint |
|---|---|
| Daftar (username, password, password2, email) | `POST /api/auth/register` |
| Masuk | `POST /api/auth/login` |
| Saldo user | `GET /api/me` |
| Bikin / revoke API key | `POST /api/keys`, `GET /api/keys`, `DELETE /api/keys?id=` |
| Iklan → Rp → token (Rp10.000 = 50.000.000.000 token) | `POST /api/credit/convert` |
| Chat dari UI workstation | `POST /api/chat` |
| API publik (Bearer `collins_live_...`) | `GET /api/v1/models`, `POST /api/v1/chat/completions` |
| Riwayat pemakaian | `GET /api/usage` |

Base URL yang dipakai user: `http://localhost:5090/api/v1` (ada di Settings → API access).

```bash
curl http://localhost:5090/api/v1/chat/completions \
  -H "Authorization: Bearer collins_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"halo"}]}'
```

## Alur token

1. Register → saldo awal 500.000 token (biar bisa langsung dites).
2. Tonton iklan di tab Ads → Convert Rp ke token.
3. Setiap request lewat Collins memotong saldo sebesar `total_tokens` dari upstream.
4. Saldo 0 → `402 insufficient_quota`.

## Config (`config.json`)

`port`, `upstream`, `upstreamKey`, `models`, `starterTokens`, `tokensPerRp`, `maxConvertRp`.

## Batasan MVP (sengaja)

- Password **plaintext** di SQLite (`data/collins.db`) — jangan dipakai publik.
- Streaming SSE **didukung** (`stream:true` diproksi apa adanya, usage tetap dipotong dari saldo).
- `glm-5.3-flash-free` sering `502 no_capacity` dari provider upstream; error-nya diteruskan apa adanya.
- Session token di localStorage, tanpa refresh/expiry.
- Agent "steps/diffs" simulasi di UI sudah tidak dipakai (diganti jawaban real).
