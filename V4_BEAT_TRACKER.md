# Dance Counter v4 – temporal beat/downbeat tracker

Esta versión cambia únicamente la lógica de seguimiento musical principal.

## Qué cambia

- Se conserva la captura de micrófono y el detector de reserva por spectral flux.
- Se acumulan **beats y downbeats completos** de Beat This! entre ventanas de inferencia.
- Ya no se usa `latest downbeat` como ancla directa.
- Se evalúan varias hipótesis de fase utilizando varios compases.
- El BPM se usa como intervalo de referencia y se permite una pequeña adaptación.
- El primer `1` automático requiere suficiente evidencia multi-compás.
- Una vez bloqueado el `1`, un falso downbeat no puede desplazar la cuenta un beat entero.
- La cuenta de 8 sigue interpretando el segundo compás como `5-6-7-8`, no como otro `1-2-3-4`.

## Archivos modificados

- `src/app/services/beat-counter.service.ts`

No se modifican los archivos Android ni la parte de permisos del micrófono.
