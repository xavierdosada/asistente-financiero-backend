# Asistente Financiero — Backend

API en **NestJS** que recibe mensajes de chat, los interpreta con **Google Gemini** y, cuando el texto describe un ingreso o un gasto, persiste un registro en **Supabase** (tabla `movements`).

## Qué hace hoy la aplicación

1. El cliente envía `POST /chat/messages` con `{ "message": "..." }` y opcional `entry_mode`.
2. Un caso de uso carga **categorías** y **tarjetas** registradas, pide a Gemini extraer moneda, monto, tipo, detalle, **categoría** (nombre que matchee el catálogo), **medio de pago**, pista de **tarjeta** si aplica, y **fecha del movimiento**.
3. Si el mensaje no corresponde a un movimiento, la API responde sin guardar nada (`saved: false` y un `reason`).
4. Si los datos son válidos, se inserta una fila en `movements` con `category_id`, `entry_mode` (`operativo` o `historico`) y, si aplica, `card_id`.
5. **CRUD** de **categorías** y **tarjetas** (ver tabla abajo). Sin categorías cargadas, el chat no puede guardar movimientos.

La arquitectura es **hexagonal**: el dominio y la aplicación no conocen detalles de Gemini ni de Supabase; eso vive en adaptadores en `infrastructure`.

## Estructura de carpetas

### `src/domain/`

Núcleo del negocio, sin dependencias de frameworks ni de proveedores externos.

| Ruta | Función |
|------|---------|
| `entities/` | `IngresoEgreso` (`categoria_id`, medio de pago, `tarjeta_id` opcional, fecha, etc.). |
| `ports/` | `TransactionRepositoryPort`, `CategoriaRepositoryPort`, `TarjetaRepositoryPort`, `AiTransactionParserPort` (contexto categorías + tarjetas). |

### `src/application/`

Orquestación de reglas de caso de uso.

| Archivo | Función |
|---------|---------|
| `process-chat-message.use-case.ts` | Lista categorías y tarjetas, parsea con IA, resuelve `categoria_id` y `tarjeta_id` por nombre / pistas de tarjeta, guarda. |

### `src/infrastructure/`

Implementaciones concretas de los puertos del dominio.

| Ruta | Función |
|------|---------|
| `ai/gemini-transaction-parser.adapter.ts` | Gemini con JSON; catálogos de categorías y tarjetas en el prompt. |
| `supabase/supabase-transaction.repository.ts` | `insert` en `movements`. |
| `supabase/supabase-categoria.repository.ts` | CRUD de `categorias`. |
| `supabase/supabase-tarjeta.repository.ts` | CRUD de `tarjetas`. |

### `src/presentation/`

Entrada HTTP y composición del módulo de esa funcionalidad.

| Ruta | Función |
|------|---------|
| `chat/chat.controller.ts` | `POST /chat/messages`. |
| `chat/chat.module.ts` | Importa `CategoriasModule` y `TarjetasModule`. |
| `caja/caja.controller.ts` | `GET /caja/resumen` (ingresos, gastos y saldo mensual de caja). |
| `caja/caja.module.ts` | Expone `ACCOUNT_REPOSITORY`. |
| `prestamos/prestamos.controller.ts` | CRUD HTTP sobre préstamos iniciales y en curso. |
| `prestamos/prestamos.module.ts` | Expone `LOAN_REPOSITORY`. |
| `categorias/categorias.controller.ts` | CRUD HTTP sobre `categorias`. |
| `categorias/categorias.module.ts` | Expone `CATEGORIA_REPOSITORY`. |
| `tarjetas/tarjetas.controller.ts` | CRUD HTTP sobre `tarjetas`. |
| `tarjetas/tarjetas.module.ts` | Expone `TARJETA_REPOSITORY`. |

### API CRUD

**Categorías** (`/categorias`): cuerpo con `nombre` en `POST` / `PATCH`.

**Tarjetas** (`/tarjetas`): cuerpo JSON con `bank`, `type_card` (`credito` \| `debito` \| `prepaga`), `payment_card` (ej. `VISA`, `MASTERCARD`) y opcional `credit_limit` (número > 0 o `null`). Ejemplo: `{"bank":"BBVA","type_card":"credito","payment_card":"VISA","credit_limit":1200000}`. La columna `name` en BD se genera como `"{payment_card} {bank} ({type_card})"`. `PATCH`: al menos uno de `bank`, `type_card`, `payment_card`, `credit_limit` (y se recalcula `name`). Si la tabla en Supabase sigue en español, ejecutá `database/migrate_tarjetas_english.sql` y recargá el esquema de la API.

| Método | Ruta | Respuesta típica |
|--------|------|------------------|
| `GET` | `/categorias`, `/tarjetas` | lista de filas |
| `GET` | `/chat/preferences` | preferencias persistentes del chat |
| `GET` | `/movements?limit=100&entry_mode=operativo|historico&from=YYYY-MM-DD&to=YYYY-MM-DD` | historial de movimientos guardados para reconstruir timeline en frontend |
| `DELETE` | `/movements/:id` | elimina un movimiento y revierte impactos vinculados (préstamos/tarjetas/cuotas/resúmenes) |
| `GET` | `/prestamos` | lista de préstamos (incluye cuotas pagadas/restantes) |
| `GET` | `/prestamos/:id/cuotas` | cronograma de cuotas del préstamo (`amount`, `paid_amount`, `status`) |
| `GET` | `/caja/resumen?year=YYYY&month=MM&currency=ARS\|USD` | resumen mensual de caja por moneda (`opening_balance`, `ajustes`, `ingresos`, `gastos`, `saldo`) |
| `GET` | `/caja/historial?year=YYYY&month=MM&currency=ARS\|USD` | apertura del mes + ajustes cronológicos para auditoría |
| `POST` | `/caja/apertura` | crea apertura mensual inicial (`year`, `month`, `opening_balance`, `currency?`) |
| `POST` | `/caja/ajuste` | agrega ajuste de caja append-only (`year`, `month`, `new_balance`, `reason`, `currency?`) |
| `GET` | `/categorias/:id`, `/tarjetas/:id` | fila o **404** |
| `GET` | `/prestamos/:id` | detalle de préstamo |
| `GET` | `/tarjetas/:id/resumen` | gasto de mes actual / siguiente y límite disponible dinámico |
| `GET` | `/tarjetas/:id/deudas` | deudas en cuotas de la tarjeta con detalle de cuotas |
| `GET` | `/tarjetas/:id/cuotas-pendientes` | cuotas pendientes/vencidas de la tarjeta (con saldo restante por cuota) |
| `GET` | `/tarjetas/:id/resumenes` | resúmenes mensuales de tarjeta (deuda real por mes) |
| `GET` | `/tarjetas/:id/resumenes/:statementId` | detalle del resumen con líneas imputadas |
| `GET` | `/tarjetas/:id/gastos?from=YYYY-MM-DD&to=YYYY-MM-DD&scope=operativo\|historico\|ambos` | gasto acumulado de tarjeta en rango + desglose mensual (default `operativo`) |
| `POST` | `/tarjetas/:id/resumenes/generar` | genera/cierra resumen mensual calendario (`year`, `month`) |
| `POST` | `/tarjetas/:id/deuda-inicial` | bootstrap de deuda actual de tarjeta para un mes (`year`, `month`, `outstanding_amount`, `due_date?`) |
| `POST` | `/asesor/messages` | chat del Asesor Financiero IA orientado a análisis con datos reales (opcional `scope=operativo\|historico\|ambos`, default `ambos`) |
| `PUT` | `/chat/preferences` | patch parcial de preferencias (`auto_create_category_default?`, `default_entry_mode?`) |
| `POST` | `/categorias`, `/tarjetas` | fila creada |
| `POST` | `/prestamos` | alta de préstamo (incluye `installment_amount`; `outstanding_amount` opcional) |
| `PATCH` | `/categorias/:id`, `/tarjetas/:id` | fila actualizada o **404** |
| `PATCH` | `/prestamos/:id` | actualización manual de préstamo |
| `DELETE` | `/categorias/:id`, `/tarjetas/:id` | `{ ok: true }` (la categoría falla si hay movimientos con esa FK) |
| `DELETE` | `/prestamos/:id` | `{ ok: true }` |

### Raíz de `src/`

| Archivo | Función |
|---------|---------|
| `main.ts` | Arranque de Nest, CORS y puerto (`PORT` o 3000). |
| `app.module.ts` | Módulo raíz que importa el módulo de chat. |

### `database/`

`ingresos_egresos.sql`: esquema legacy inicial.

`financial_model_v1.sql`: esquema nuevo en inglés (`profiles`, `categories`, `cards`, `movements`, etc.).

`financial_model_v1_rls.sql`: políticas RLS para el modelo v1.

`financial_model_v1_delete_reversal.sql`: fase 2 para borrado reversible de movimientos (soft delete + `movement_effects`, presupuestos y cuotas de préstamo).

`financial_model_v1_delete_reversal_rls.sql`: políticas RLS para la fase 2.

`financial_model_v1_delete_reversal_fn.sql`: función RPC `delete_movement_with_reversal(...)` usada por `DELETE /movements/:id` para aplicar reversión consistente.

`financial_model_v1_delete_reversal_fn_wrapper.sql`: wrapper RPC estable `delete_movement_with_reversal_v1(...)` para evitar conflictos de firma/cache en PostgREST.

Para el flujo de caja mensual con modelo `movements/accounts`, corré también:

- `database/add_cards_credit_limit.sql`
- `database/add_cash_accounts_and_movements_account.sql`
- `database/add_cash_monthly_openings.sql`
- `database/add_cash_monthly_adjustments.sql`
- `database/refactor_card_statements_monthly.sql`
- `database/add_chat_preferences.sql`
- `database/normalize_categories_case_insensitive.sql`
- `database/refactor_loans_installment_amount.sql`
- `database/add_movements_entry_mode.sql`
- `database/update_chat_preferences_default_entry_mode.sql`
- `database/update_apply_movement_trigger_for_entry_mode.sql`
- `database/fix_loan_installments_progress_consistency.sql` (si ves desfasajes de cuota actual al registrar pagos de préstamo)

Orden recomendado de migraciones nuevas:
1. `add_movements_entry_mode.sql`
2. `update_chat_preferences_default_entry_mode.sql`
3. `update_apply_movement_trigger_for_entry_mode.sql`

### Semántica de `entry_mode`

- `operativo`: impacta caja, imputación automática de pagos/deudas y resúmenes.
- `historico`: queda registrado para contexto analítico/IA, **sin impacto operativo**.

`POST /chat/messages` acepta:

```json
{
  "message": "Pagué 120000 de la tarjeta",
  "entry_mode": "operativo",
  "auto_create_category": true
}
```

Precedencia de `entry_mode`:
1. Si viene en request, se usa ese.
2. Si no viene, usa `default_entry_mode` de `GET /chat/preferences`.

Si el mensaje describe un consumo con tarjeta "en N cuotas" (ej. "en 3 cuotas"), el backend:
- guarda `installments_total` en `movements`;
- crea automáticamente la deuda en `card_installment_debts` y su detalle en `card_debt_installments` (solo en `entry_mode=operativo`).

### Caja multi-moneda (ARS/USD)

- La caja se separa por moneda: `Caja ARS` y `Caja USD`.
- No hay conversión automática entre monedas.
- Un movimiento en efectivo impacta solo la caja de su `currency`.
- La apertura mensual se crea una sola vez por mes; si hay diferencias de arqueo, se registran con `POST /caja/ajuste` (append-only).
- No hay rollover automático entre meses: cada mes arranca con su propia apertura (si no existe, el valor base es `0` hasta cargarla).

Ejemplos:

```bash
curl -X POST "http://localhost:3000/caja/apertura" \
  -H "Content-Type: application/json" \
  -d '{"year":2026,"month":4,"opening_balance":150000,"currency":"ARS"}'

curl -X POST "http://localhost:3000/caja/apertura" \
  -H "Content-Type: application/json" \
  -d '{"year":2026,"month":4,"opening_balance":1500,"currency":"USD"}'

curl "http://localhost:3000/caja/resumen?year=2026&month=4&currency=ARS"
curl "http://localhost:3000/caja/resumen?year=2026&month=4&currency=USD"
```

## Variables de entorno

Colocá un archivo **`.env` en la carpeta `backend/`** (junto a `package.json`). Al arrancar, `src/load-env.ts` lo carga antes de Nest; Node **no** lee `.env` solo.

| Variable | Uso |
|----------|-----|
| `SUPABASE_URL` | URL del proyecto Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave de servicio (solo servidor) para insertar filas. |
| `APP_USER_ID` | UUID existente en `auth.users` que usa el backend para escribir/leer `categories`, `cards` y `movements`. |
| `G_GEMINI_API_KEY` | Clave de la [Google AI Studio](https://aistudio.google.com/apikey) (Gemini). |
| `GEMINI_MODEL` | Opcional; por defecto `gemini-2.5-flash`. Si Google depreca el id, fijate los modelos listados en la consola / documentación y asigná uno acá. |
| `PORT` | Opcional; puerto HTTP del servidor. |

## Cómo ejecutarlo

```bash
cd backend
npm install
npm run start:dev
```

Asegurate de tener las variables de entorno definidas y la tabla creada en Supabase según `database/ingresos_egresos.sql`.
