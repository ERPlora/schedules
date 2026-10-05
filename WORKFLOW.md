# WORKFLOW — Horarios

Prefijo: SCHEDULES
Alcance MVP: peluqueria

## Para qué sirve y para quién
Dice **cuándo está abierto el negocio**: la semana habitual (con turno partido, abierto 24 horas,
cerrado o tramos que cruzan la medianoche), los **días especiales** (un festivo cerrado o un día con
otro horario, que puede repetirse cada año) y los **cambios temporales** (un rango de fechas con
otro horario o cerrado: vacaciones, horario de verano, obras). Es el horario **del negocio**: no es
el turno de un profesional (eso es de **Personal**) ni las horas que se pueden reservar (eso es de
**Citas**). Lo configuran el **administrador** y el **responsable**; el **empleado** solo lo ve. El
primer y único módulo que hoy lo lee para decidir algo es **Citas**: con él ofrece horas libres y
rechaza una reserva fuera de horario.

## Referencia adoptada
El contraste de mercado de este módulo ya está hecho y registrado en el propio código; no se rehace aquí.
- **Google Business Profile** (business.google.com): varios tramos por día, «abierto 24 horas»
  como 00:00–00:00 y horario especial por fecha (`handler/src/lib.rs`, comentarios de `Interval`).
- **Square**, **Fresha** y **Google Business Profile**: siete filas fijas, un día se edita y nunca se «añade»
  (`ui/components/erp-schedules-hours/erp-schedules-hours.ts`, comentario de `WeekRow`).
- **Odoo**, **Google Calendar**, **Microsoft Bookings**, **Business Central** y **Lightspeed
  Reservations**: la semana por defecto de lunes a viernes sin pausa, con el fin de semana cerrado
  (`seed/install.postgres.sql`, decisión de schedules#36 hecha con `market-decision`).
- **Salón** (Fresha, Vagaro, Mangomint, DaySmart): regla 4 de `.claude/qa/qa-method-shared.md`.
- Decisión registrada que manda aquí: ADR-0392 (sin regla para el día, el negocio no se da por
  abierto: código `no_hours`), según los comentarios del código; el ADR no se ha abierto en este encargo.

## Antes de empezar
1. Instala **Horarios** (lo trae **Citas**, que lo exige). Al instalarlo ya tiene una semana por
   defecto (SCHEDULES-F12): de lunes a viernes de 09:00 a 18:00 y sábado y domingo cerrados.
2. Comprueba en **Ajustes del hub** la zona horaria del negocio (SCHEDULES-F09): con ese reloj se
   lee todo el horario.
3. En **Horarios → Horario**, pulsa **Sí, este es mi horario** si la semana por defecto es la tuya
   (SCHEDULES-F03) o edita los días que cambian (SCHEDULES-F02).
4. En **Días especiales**, añade los próximos festivos y cierres (SCHEDULES-F04) y, para vacaciones
   de varios días, un cambio temporal (SCHEDULES-F05).
5. Si quieres que la semana empiece en domingo, cámbialo en **Ajustes** (SCHEDULES-F08).

## Pantallas

### Horario
Menú → **Horarios** → pestaña **Horario** (la primera). Tabla de **siete filas fijas**, una por día
de la semana, con las columnas **Día**, **Horario** y **Estado**; no hay botón de añadir: un día se
edita. La columna Horario dice, por ejemplo, «10:00–14:00 · 17:00–20:00», «Abierto 24 horas»,
«Cerrado» o «Sin definir»; Estado dice «Cerrado», «Abierto» o «—» (día sin definir). Las horas salen
en el reloj del idioma del hub (24 horas en español, AM/PM en inglés). Por fila, la acción
**Editar** (tocar la fila hace lo mismo) abre el panel «Editar horario — {día}» con: selector **Día**,
casilla **Cerrado**, casilla **Abierto 24 horas**, una línea por tramo (hora de apertura y de cierre,
**Quitar tramo**), **+ Añadir tramo**, una pista («Jornada partida: una línea por tramo (10:00–14:00 y
17:00–20:00). Un cierre anterior a la apertura pasa de medianoche (22:00–02:00).») y **Guardar día**.
Mientras la semana siga siendo la que puso el instalador, encima de la tabla sale un aviso amarillo
«Este es un horario por defecto que hemos puesto por ti. Comprueba que coincide con el de tu
negocio: las reservas fuera de él se rechazan.» con el botón **Sí, este es mi horario**. En móvil y
tableta (hasta 834 px) las filas se pintan como tarjetas. Cargando: «Cargando…» · Error: la tabla
dice «No se han podido cargar los datos», con la causa debajo y **Reintentar** (vuelve a leer la
semana y los ajustes); el mismo error sale si fallan los ajustes, porque sin ellos no se sabe por qué
día empezar. En un hub con una OutfitKit anterior a la 0.1.113 sale en su lugar «No se ha podido
cargar el horario.» y la causa arriba de la página. La frase «Sin horario configurado.» está en el catálogo,
pero la pantalla nunca la enseña: con la semana leída siempre hay siete filas.

### Días especiales
Pestaña **Días especiales**. Dos tablas una debajo de otra, cada una con su título.
- **Días especiales**: columnas **Fecha**, **Nombre**, **Estado** (dice «Cerrado» o las horas del
  día, tramo a tramo) y **Anual** («Sí»/«No»); buscador «Buscar día especial…», filtros por fecha,
  nombre, estado y anual, orden por columna, conmutador lista/tarjetas y paginación de 50 filas. Botón
  **Nuevo día especial** → formulario con **Fecha** (en el orden de día y mes del idioma del hub,
  «dd/mm/aaaa»), **Nombre** («Nombre (p.ej. Navidad)»), **Estado** («Cerrado» o «Abierto (con
  horario)»; empieza en Cerrado), el mismo editor de tramos que el horario semanal, **Se repite cada
  año**, **Notas** y **Añadir día**. Por fila solo hay una acción, **Eliminar**.
- **Cambios temporales**: columnas **Desde**, **Hasta**, **Motivo** y **Estado**; buscador «Buscar
  cambio temporal…» y los mismos controles. Botón **Nuevo cambio temporal** → formulario con
  **Desde**, **Hasta**, **Motivo**, **Estado**, el editor de tramos y **Añadir cambio temporal**.
  Por fila, **Eliminar**.
- Eliminar pide confirmar: título «Eliminar», «Se eliminará «{nombre}». No se puede deshacer.» con
  **Cancelar** y **Eliminar**.
- Vacías: «Sin días especiales.» / «Sin cambios temporales.» · Cargando: «Cargando…» · Error: la
  tabla dice «No se han podido cargar los datos» con la causa y **Reintentar** (también si fallan los
  tramos); en un hub con una OutfitKit anterior a la 0.1.113 sale en su lugar el motivo de la lista, o
  «No se ha podido cargar el horario de los días especiales.» si fallan los tramos. Las listas no se enseñan hasta tener también los tramos, para que un
  día partido nunca se vea con solo su primer tramo.
- Un rechazo al guardar sale **dentro del formulario**, encima del botón, no en la página.

### Ajustes
Pestaña **Ajustes**. Arriba, solo lectura, «Zona horaria del negocio» con el nombre de la zona (o
«Este hub todavía no la publica»), la nota «Se toma del hub: se declara en Ajustes o se deduce del
país del negocio. Es el único reloj con el que se lee el horario: aquí se muestra y allí se cambia.»
y el botón **Abrir ajustes del hub**. Debajo, el formulario con **Semana empieza** (Lunes o Domingo)
y **Guardar**. Cargando: «Cargando…» · Error: «No se han podido cargar los ajustes.» con la causa y
**Reintentar** / «Reintentando…»; con el error no se enseña el selector, para no guardar un valor
que no se ha leído.

Las tres pestañas las pinta el hub con los nombres «Horario», «Días especiales» y «Ajustes»; ninguna
entrada declara permiso, así que las ven todos los perfiles, el empleado incluido.

## Flujos

### SCHEDULES-F01 Ver el horario de la semana
Estado: hecho
Actor: empleado, responsable, administrador
Pantalla: Horario
Pasos:
1. Abre **Horarios**; la pestaña **Horario** muestra los siete días.
2. Lee de cada día sus tramos, «Abierto 24 horas», «Cerrado» o «Sin definir».
3. Si la semana empieza en domingo (SCHEDULES-F08), la tabla abre por el domingo; solo cambia el orden.
Entra: las filas semanales del negocio y el ajuste «Semana empieza».
Sale: nada; solo lectura.
Si falla: la tabla dice «No se han podido cargar los datos» con la causa y **Reintentar** (en una OutfitKit anterior a la 0.1.113, «No se ha podido cargar el horario.»); hasta que se lea todo no se pinta ni una fila, para no enseñar siete «Sin definir» que parecerían un negocio sin horario.
Implicados: ninguno
QA: ninguno

### SCHEDULES-F02 Fijar el horario de un día
Estado: hecho
Actor: responsable, administrador
Pantalla: Horario
Pasos:
1. En **Horario**, pulsa **Editar** en el día (o toca la fila): se abre «Editar horario — {día}». Puedes cambiar de día con el selector **Día**.
2. Elige una de tres cosas: marca **Cerrado**; marca **Abierto 24 horas**; o escribe un tramo por línea con su apertura y su cierre (por ejemplo 10:00–14:00 y 17:00–20:00 para un turno partido; 22:00–02:00 pasa de medianoche). Las horas se aceptan como «14:30», «2:30 pm» o «1430».
3. Pulsa **Guardar día**.
4. El panel se cierra y la fila enseña el resumen nuevo. Guardar **sustituye** los tramos anteriores de ese día: no se acumulan.
Entra: el día y sus tramos, de quien edita. Un tramo con apertura y cierre iguales (salvo 00:00–00:00) no vale. Hasta 12 tramos por día. El orden da igual: se guardan ordenados.
Sale: los tramos del día guardados con el usuario que los firmó, y el aviso de horario cambiado (`schedules.business_hours.updated`), que hoy no escucha ningún módulo. Citas lo lee en la reserva siguiente (SCHEDULES-F11).
Si falla: el motivo sale dentro del panel («Indica la hora de apertura y cierre, o márcalo como cerrado» si una línea está a medias; «Hora no válida» bajo el campo ilegible; «Dos tramos se solapan…» si se pisan, también a través de la medianoche) y lo escrito se conserva. Sin permiso, el empleado no escribe: el hub le pide el PIN de un responsable.
Implicados: APPOINTMENTS-F01, APPOINTMENTS-F02, REC_PELUQUERIA-F02
QA: BD-06

### SCHEDULES-F03 Confirmar la semana por defecto
Estado: hecho
Actor: responsable, administrador
Pantalla: Horario
Pasos:
1. En **Horario**, con el aviso amarillo «Este es un horario por defecto…» a la vista, comprueba que los días son los de tu negocio.
2. Pulsa **Sí, este es mi horario**; el botón se desactiva mientras trabaja.
3. El aviso desaparece y el paso «Confirma tu horario» de la lista de puesta en marcha del hub queda hecho.
Entra: la semana que ya está guardada; no se manda ninguna hora, así que nadie puede firmar un horario que no se le ha enseñado.
Sale: la misma semana, tramo a tramo, firmada con el usuario que pulsa y en una sola operación (todo o nada), y un aviso de horario cambiado por cada día (`schedules.business_hours.updated`). Cambia la firma, no una hora; el descanso antiguo de una fila previa a los tramos se conserva.
Si falla: el motivo sale arriba de la página («No se pudo confirmar el horario» si no hay otro texto); la semana queda como estaba. Sin ninguna fila guardada la orden se rechaza con «Un día abierto necesita al menos un tramo horario.», pero desde la pantalla no se puede llegar ahí: el aviso solo sale cuando hay semana.
Implicados: REC_PELUQUERIA-F02
Pendiente de enlazar: hub — la lista de puesta en marcha que pinta el paso «Confirma tu horario» y lo marca hecho
QA: BD-01

### SCHEDULES-F04 Añadir un día especial
Estado: parcial — un día ya creado no se puede corregir (hay que borrarlo y crearlo otra vez) y, una vez borrado, la misma fecha no se puede volver a usar (y el lote de SCHEDULES-F07 la da por creada sin crearla)
Actor: responsable, administrador
Pantalla: Días especiales
Pasos:
1. En **Días especiales**, pulsa **Nuevo día especial**.
2. Escribe la **Fecha** y el **Nombre** (los dos obligatorios; el botón **Añadir día** no se activa sin ellos).
3. Deja **Cerrado** (lo que viene marcado) o elige «Abierto (con horario)» y escribe uno o más tramos, igual que en SCHEDULES-F02.
4. Marca **Se repite cada año** solo si cae el mismo día y mes todos los años (Navidad); opcionalmente escribe **Notas**.
5. Pulsa **Añadir día**: el panel se cierra y el día aparece en la lista.
Entra: fecha, nombre, cerrado o tramos, anual y notas, de quien crea. Una fecha ha de existir en el calendario (el 31 de febrero no vale). Solo hay un día especial vivo por fecha.
Sale: el día especial con sus tramos y el aviso de día especial creado (`schedules.special_day.created`), que hoy no escucha ningún módulo. Gana a todo lo demás ese día (SCHEDULES-F10, SCHEDULES-F11). Un día anual vale **todos los años**, también los anteriores a su fecha, y el del 29 de febrero solo existe los años bisiestos.
Si falla: «Ya existe un día especial en esa fecha.» (la lectura del servidor lo dice antes de escribir); «Un día abierto necesita al menos un tramo horario.»; «Dos tramos se solapan…». Si el nombre son solo espacios, el botón no hace nada y no dice por qué. Borrar un día especial y volver a crear otro en **esa misma fecha** falla en la base de datos, porque el índice único de la fecha cuenta también los días borrados. No sale «Ya existe un día especial en esa fecha.»: la orden no traduce el error de clave duplicada, así que el panel enseña el mensaje genérico del hub o «No se pudo crear el día especial».
Implicados: APPOINTMENTS-F01, APPOINTMENTS-F02, REC_PELUQUERIA-F02
QA: BD-06

### SCHEDULES-F05 Añadir un cambio temporal
Estado: parcial — un cambio ya creado no se puede corregir (hay que borrarlo y crearlo otra vez) y el tramo que cruza la medianoche solo vale hasta las 24:00 de su día
Actor: responsable, administrador
Pantalla: Días especiales
Pasos:
1. En **Días especiales**, en la tabla «Cambios temporales», pulsa **Nuevo cambio temporal**.
2. Escribe **Desde**, **Hasta** y **Motivo** (los tres obligatorios).
3. Deja **Cerrado** (vacaciones del negocio) o elige «Abierto (con horario)» y escribe los tramos que valen durante esas fechas (horario de verano, por ejemplo).
4. Pulsa **Añadir cambio temporal**: el panel se cierra y el cambio aparece en la lista.
Entra: las dos fechas, el motivo, cerrado o tramos. El cambio vale todos los días del rango, ambos incluidos, con las mismas horas.
Sale: el cambio con sus tramos y el aviso de cambio temporal creado (`schedules.override.created`), que hoy no escucha ningún módulo. Gana al horario semanal, pero pierde contra un día especial de esa fecha.
Si falla: «La fecha de fin no puede ser anterior a la de inicio.»; «Un día abierto necesita al menos un tramo horario.»; y si el rango toca otro cambio temporal ya guardado (aunque sea de un solo día, también uno cerrado) sale «Dos tramos se solapan (o uno cruza la medianoche sobre otro)…», un texto pensado para tramos y no para rangos. Un cambio temporal puede pisar un día especial: no se avisa. Si el motivo son solo espacios, el botón no hace nada y no dice por qué.
Implicados: APPOINTMENTS-F01, APPOINTMENTS-F02, REC_PELUQUERIA-F02
QA: BD-06

### SCHEDULES-F06 Borrar un día especial o un cambio temporal
Estado: parcial — la fecha de un día especial borrado queda ocupada y no se puede volver a usar (SCHEDULES-F04), y el lote de SCHEDULES-F07 la da por creada sin crearla
Actor: responsable, administrador
Pantalla: Días especiales
Pasos:
1. En la fila, pulsa **Eliminar**.
2. En el aviso «Se eliminará «{nombre}». No se puede deshacer.» pulsa **Eliminar** (o **Cancelar**).
3. La fila desaparece de la lista; vuelve a regir el horario semanal en esas fechas.
Entra: el día especial o el cambio temporal elegido. El permiso es el de borrar, distinto del de crear.
Sale: la fila y sus tramos quedan borrados en la misma operación, y el aviso de día especial o cambio temporal borrado (`schedules.special_day.deleted`, `schedules.override.deleted`). El borrado es lógico: la fila se queda marcada, no se pierde.
Si falla: el motivo sale arriba de la página («No se pudo eliminar» si no hay otro texto). Borrar algo que ya no existe, o de otro negocio, **responde bien, no borra nada y emite igualmente el aviso**: nada comprueba que haya cambiado una fila.
Implicados: APPOINTMENTS-F01, APPOINTMENTS-F02
QA: ninguno

### SCHEDULES-F07 Cargar varios días especiales de golpe
Estado: parcial — solo asistente o API, sin pantalla ni calendario de festivos precargado
Actor: asistente
Pantalla: asistente
Pasos:
1. Pide al asistente que cargue una lista de festivos con fecha y nombre (hasta 366).
2. Cada uno es cerrado salvo que traiga `is_closed: false` junto con la hora de apertura y la de cierre; si trae horas pero no `is_closed: false`, se guarda **cerrado** (las horas se quedan en la fila y no cuentan). Puede marcarse anual.
3. El asistente informa de cuántos se crearon y de cuáles no, con el motivo.
Entra: la lista de días de quien la pide. Cada día lleva fecha y nombre; solo admite el par apertura/cierre (con el cierre posterior a la apertura), nunca varios tramos ni tramos que crucen la medianoche.
Sale: un día especial por cada día válido y un aviso de día especial creado por cada uno (`schedules.special_day.created`). Un día con una fecha que no existe en el calendario, un nombre de solo espacios, el cierre no posterior a la apertura, o una fecha repetida dentro de la lista o ya ocupada, se salta sin parar el resto y vuelve con su código de error. Un día sin nombre, con una hora mal escrita o con un campo desconocido hace rechazar la lista **entera**, porque el esquema se valida antes.
Si falla: con la lista vacía se rechaza («La lista de días especiales no puede estar vacía.»). Si un día cae en la fecha de un día especial **borrado**, la base de datos lo descarta sin avisar: el resultado lo cuenta como creado y se emite el aviso de creado, pero el día no existe (pasa siempre, con la lectura de fechas bien hecha). Lo mismo si la lectura de fechas ocupadas no llegase: el lote no comprueba nada y la base de datos descarta en silencio las fechas que ya existan.
Implicados: APPOINTMENTS-F01, APPOINTMENTS-F02
QA: ninguno

### SCHEDULES-F08 Elegir con qué día empieza la semana
Estado: hecho
Actor: responsable, administrador
Pantalla: Ajustes
Pasos:
1. En **Ajustes**, elige en **Semana empieza** Lunes o Domingo.
2. Pulsa **Guardar**.
3. La tabla de **Horario** abre por el día elegido.
Entra: el día de inicio. La pantalla solo ofrece lunes o domingo; el servidor acepta de 1 (lunes) a 7 (domingo), pero la pantalla trata cualquier otro valor como lunes.
Sale: el ajuste del negocio y el aviso de ajustes guardados (`schedules.settings.saved`), que se emite siempre, también si el valor no cambia. Solo mueve el orden de las filas: no cambia ninguna hora ni lo que contesta SCHEDULES-F10. No sale ningún mensaje de «guardado».
Si falla: el motivo sale arriba de la página («No se pudieron guardar los ajustes» si no hay otro texto). Sin permiso de ajustes (el empleado), el hub pide el PIN de un responsable.
Implicados: ninguno
QA: ninguno

### SCHEDULES-F09 Ver la zona horaria con la que se lee el horario
Estado: hecho
Actor: empleado, responsable, administrador
Pantalla: Ajustes
Pasos:
1. Abre **Ajustes**; arriba aparece «Zona horaria del negocio» con su nombre (por ejemplo, Europe/Madrid).
2. Si no es la tuya, pulsa **Abrir ajustes del hub** y cámbiala allí.
Entra: la zona que el hub resuelve (la que declara el negocio o la que deduce de su país) y entrega a la pantalla y al motor a la vez.
Sale: nada; solo lectura. Horarios no guarda zona propia: las horas son de pared (las 10:00 son las 10:00 antes y después del cambio de hora, sin tocar nada).
Si falla: si el hub no la publica, sale «Este hub todavía no la publica». Si el motor no reconoce la zona, calcula en UTC y la respuesta lo dice (SCHEDULES-F10). **Abrir ajustes del hub** abre Ajustes en la pestaña del negocio, donde están el país y la zona horaria.
Implicados: REC_PELUQUERIA-F02
Pendiente de enlazar: hub — la zona horaria del negocio que el hub declara o deduce del país y entrega a los módulos
QA: BD-06

### SCHEDULES-F10 Preguntar si el negocio está abierto en un momento
Estado: hecho
Actor: asistente
Pantalla: ninguna
Pasos:
1. El asistente (o una integración con la llave de API) pregunta por un instante: con zona (`2026-08-18T08:00:00Z`) lo convierte al reloj del negocio; sin zona (`2026-08-18T10:00`) lo lee tal cual; sin nada, contesta para ahora.
2. Recibe la respuesta: abierto o cerrado, la regla que decidió, la zona usada, el día y la hora locales y un código estable del motivo.
Entra: solo el momento; el horario lo lee el servidor de este negocio, nunca lo manda quien pregunta. Hace falta poder ver horarios.
Sale: nada guardado. La respuesta lleva `is_open`, `code` (`exception_closed`, `exception_hours`, `open_interval`, `on_break`, `closed_today`, `overnight_open`, `outside_hours` o `no_hours`), `source` (`special_day`, `override`, `business_hours` o `none`), `rule_id`, los tramos que lo explican, `timezone`, `today`, `current_time` y, solo si es dato del usuario, `reason` (el nombre del día especial o el motivo del cambio que ganó). Orden: día especial de la fecha exacta, día especial anual del mismo día y mes, cambio temporal que cubre la fecha, horario semanal, nada. Se está abierto desde la hora de apertura y se deja de estar justo a la de cierre (a las 18:00 en punto ya está cerrado). La madrugada de un tramo semanal que cruza la medianoche cuenta como abierta, aunque la víspera la cerrara un día especial o un cambio temporal, y no cuenta si ese mismo día tiene su propio día especial o cambio temporal; la de un tramo de día especial o de cambio temporal no cuenta: esa madrugada la deciden las reglas del día siguiente. Citas hace lo mismo. Un día sin ninguna fila (con otros días definidos) contesta `no_hours`: no está abierto.
Si falla: un instante que no tiene la forma AAAA-MM-DDTHH:MM se rechaza en la validación del hub; uno con esa forma pero con una fecha u hora que no existen, con «Esa fecha no es válida: debe ser una fecha real del calendario (AAAA-MM-DD).». Ningún módulo llama hoy a esta orden: Citas lee las cuatro listas y aplica la misma precedencia por su cuenta (SCHEDULES-F11), y la receta de WhatsApp pregunta a Citas.
Implicados: APPOINTMENTS-F01, APPOINTMENTS-F02
Pendiente de enlazar: hub — el reloj del negocio que el hub entrega ya resuelto al motor
QA: ninguno

### SCHEDULES-F11 Dar el horario de un día a Citas
Estado: hecho
Actor: sistema
Pantalla: ninguna
Pasos:
1. Citas necesita saber si puede ofrecer o aceptar una hora (al ofrecer horas libres, al reservar, al mover o cambiar una cita, en una serie).
2. El servidor le entrega, junto con la orden, las cuatro listas de Horarios de ese negocio: tramos semanales, días especiales, cambios temporales y tramos de las excepciones.
3. Citas decide con ellas y solo si la cita cabe **entera** dentro de un tramo abierto.
Entra: las cuatro listas de Horarios; Citas las declara obligatorias y exige Horarios instalado (`schedules` ≥ 2.0.28 en su manifest). La zona horaria es la del hub.
Sale: nada de Horarios. Citas aplica el mismo orden que SCHEDULES-F10 (día especial exacto, anual, cambio temporal, semana), con estas diferencias que importan: con **cero filas semanales** y sin excepción esa fecha, deja reservar a cualquier hora (F10 diría `no_hours`); el final de la cita puede coincidir con el cierre (F10 cierra a la hora exacta); y una cita puede cruzar la medianoche dentro de un tramo de excepción que la cruza.
Si falla: si una de las cuatro listas no se puede leer, el hub corta la reserva antes de que Citas decida (error `read_unavailable`) y no se reserva a ciegas. Si una lista no llega sin dar error, Citas la rechaza con su código `appointments.availability_unavailable`, cuyo texto en español habla de «los bloqueos de la agenda» y no del horario.
Implicados: APPOINTMENTS-F01, APPOINTMENTS-F02, APPOINTMENTS-F04, APPOINTMENTS-F06, APPOINTMENTS-F13, APPOINTMENTS-F14, APPOINTMENTS-F21, APPOINTMENTS-F22, REC_PELUQUERIA-F06, REC_WA_CITA-F04
QA: B-02, BD-06, W-02, W-06

### SCHEDULES-F12 Partir de una semana por defecto al instalar
Estado: hecho
Actor: sistema
Pantalla: ninguna
Pasos:
1. Al instalar Horarios en un hub (y en cada actualización del módulo), el instalador mira si el negocio no tiene ninguna fila semanal.
2. Si no tiene, planta lunes a viernes de 09:00 a 18:00 y sábado y domingo cerrados, firmados por «system».
3. El hub lo enseña como semana sin confirmar (aviso amarillo de la pantalla Horario, SCHEDULES-F03, y paso «Confirma tu horario»).
Entra: nada de la persona; el horario por defecto es el del mercado, no del negocio.
Sale: siete filas semanales. La guarda es de tabla entera: si el negocio tiene alguna fila, viva o borrada, no se planta nada; así una actualización no devuelve días que se dejaron fuera. El catálogo de arranque de peluquería se adueña de esas filas y pone la suya (lunes a viernes 09:30–20:00 con descanso de 14:00 a 16:00, sábado 09:30–14:00, domingo cerrado), firmada sin autor, por lo que el aviso no sale y el paso queda hecho. El exportador del hub no copia la semana mientras nadie la haya tocado y la copia entera en cuanto el negocio firma una fila.
Si falla: no hay pantalla; si la semilla no corriera, el negocio no tendría filas y Citas dejaría reservar a cualquier hora (SCHEDULES-F11).
Implicados: REC_PELUQUERIA-F02
Pendiente de enlazar: hub — el instalador que aplica la semilla del módulo al instalar y al actualizar
Pendiente de enlazar: blueprints — el catálogo de arranque de peluquería que sustituye la semana por defecto por la del salón
QA: BD-01

## Cobertura contra la referencia
| Elemento | Estado | Flujo |
|---|---|---|
| Semana con varios tramos por día (turno partido) | hecho | SCHEDULES-F02 |
| Día cerrado y día abierto 24 horas | hecho | SCHEDULES-F02 |
| Tramo que cruza la medianoche en el horario semanal | hecho | SCHEDULES-F02, SCHEDULES-F10 |
| Tramo que cruza la medianoche en un día especial o cambio temporal | parcial — vale hasta las 24:00 de su día; la madrugada siguiente la deciden las reglas del día siguiente | SCHEDULES-F04, SCHEDULES-F05, SCHEDULES-F10 |
| Semana por defecto al alta y confirmarla de un toque | hecho | SCHEDULES-F12, SCHEDULES-F03 |
| Festivo o día con horario distinto, cerrado o con tramos | hecho | SCHEDULES-F04 |
| Festivo que se repite cada año | hecho | SCHEDULES-F04 |
| Editar un festivo o un cambio ya creado | no hecho — se borra y se vuelve a crear, y la fecha de un día especial borrado no se puede reusar | SCHEDULES-F04, SCHEDULES-F05, SCHEDULES-F06 |
| Vacaciones del negocio (rango de fechas) y horario de verano | hecho | SCHEDULES-F05 |
| Cargar varios festivos de una vez | parcial — solo asistente o API; una fecha de día borrado se da por creada sin crearse | SCHEDULES-F07 |
| Calendario de festivos del país precargado | no hecho — no se siembra ninguno | — |
| Varias plantillas de horario (verano/invierno sin fechas) | fuera del MVP — para eso están los cambios temporales | — |
| Horario distinto por sede o local | fuera del MVP — un hub es un negocio | — |
| Horario por profesional | hecho en otro componente (Personal); Horarios no lo conoce | — |
| Zona horaria del negocio y cambio de hora oficial | hecho — es del hub y las horas son de pared | SCHEDULES-F09 |
| Preguntar si el negocio está abierto en un momento | hecho — solo asistente o API, nadie más lo llama | SCHEDULES-F10 |
| El módulo que reserva respeta el horario | hecho — solo Citas | SCHEDULES-F11 |

## Datos: de quién es cada dato
| Dato | Dueño | Cómo lo obtiene Horarios |
|---|---|---|
| Tramos semanales, días especiales, cambios temporales y sus tramos | Horarios | propio |
| «Semana empieza» | Horarios | propio (una fila por negocio) |
| Zona horaria del negocio | Hub | la entrega el hub ya resuelta; Horarios no la guarda (la columna antigua sigue en la tabla de ajustes; la consulta la devuelve pero nada la usa) |
| Quién firmó la semana («system» = instalador; sin autor = catálogo de arranque) | Horarios | la auditoría de cada fila semanal; de ahí sale el aviso y el paso de puesta en marcha |
| Descanso antiguo (`break_start`/`break_end`) de una fila semanal, y par apertura/cierre de un día especial o cambio temporal sin tramos | Horarios | propio; siguen contando: el motor, Citas y la pantalla los leen, y el catálogo de peluquería escribe su semana con descanso |
| Citas, personal, venta | otros | Horarios no los lee ni los escucha |

**Datos personales (inventario RGPD, recorriendo las migraciones):** Horarios no guarda datos de
clientas ni de empleados. Lo que hay son campos de texto libre que el negocio puede llenar con
nombres: el **nombre** y las **notas** de un día especial y el **motivo** de un cambio temporal (el
nombre y el motivo viajan también dentro de los avisos de «creado»). Además, en todas las tablas
(ajustes, tramos semanales, días especiales, cambios temporales y tramos de excepción), la
auditoría guarda **quién creó y quién cambió** cada fila (usuario del hub) y, al borrar, cuándo. Los
borrados son lógicos: nada se elimina de la base de datos. No hay tablas retiradas con otro nombre;
las columnas antiguas de ajustes (zona, duración de hueco, cierre automático) siguen en su tabla: la
consulta las devuelve y nada las usa. Siguen contando, en cambio, el descanso antiguo de las filas
semanales y el par apertura/cierre de las excepciones sin tramos. El aviso de «borrado» lleva solo el
id de lo borrado y los datos del sistema (negocio, usuario, hora): ni el nombre ni el motivo. Horarios no escucha el borrado de personas.

## Reglas que no se rompen
- **Aislamiento por hub:** toda lectura y toda escritura del módulo filtra por el negocio; un tramo
  de excepción solo se escribe si su día especial o cambio existe vivo en el mismo negocio. El
  motor no acepta un horario de quien pregunta: solo el momento.
- **Permisos por acción:** ver (los tres perfiles), crear días y cambios, fijar el horario, borrar
  y guardar ajustes son cinco permisos distintos; el empleado solo ve. Sin permiso, la orden no se
  ejecuta; el hub ofrece el PIN de un responsable cuando el responsable lo tiene.
- **Los tramos de un día, de un día especial o de un cambio temporal no se solapan**, tampoco a
  través de la medianoche, y se guardan ordenados. Lo comprueba el servidor antes de escribir nada.
- **Un solo día especial vivo por fecha** (lectura del servidor y índice único). Con la salvedad de
  SCHEDULES-F04: el índice también cuenta los borrados.
- **Dos cambios temporales vivos no cubren la misma fecha**, para que la respuesta no dependa del orden de la lista. Se comprueba al crear, con una lectura del servidor que no es obligatoria; no hay restricción en la base de datos, así que dos altas simultáneas, o un alta cuya lectura falle, pueden dejar dos cambios sobre la misma fecha.
- **Un día abierto necesita al menos un tramo completo:** el servidor no deja crear un día especial,
  un cambio temporal ni un día de la semana abiertos sin horas. (Si quedase una fila antigua así, el
  motor y Citas la leerían como abierta todo el día.)
- **Un día especial o un cambio borrado se lleva sus tramos** en la misma operación.
- **Precedencia única:** día especial de la fecha, día especial anual, cambio temporal, horario
  semanal, nada. Citas y el motor la aplican igual.
- **Las horas son de pared del negocio**; el instante se convierte con la zona del hub, con el
  cambio de hora oficial incluido.
- **Nunca se escribe una hora que el negocio no vio:** confirmar la semana re-firma la que hay, no una que se mande.

## Lo que NO hace, a propósito
- No guarda turnos de profesionales ni ausencias (Personal) ni las horas reservables (Citas).
- No cierra la caja ni impide vender fuera de horario: ningún módulo salvo Citas lo lee, y los avisos
  que emite no los escucha nadie.
- No avisa a nadie de que el negocio abre o cierra, ni cierra nada solo (el ajuste de cierre
  automático se retiró porque ningún código lo leía).
- No tiene zona horaria propia ni duración de hueco: la zona es del hub y la duración, del servicio.
- No trae festivos del país: cada día especial lo escribe el negocio.
- No edita un día especial ni un cambio temporal: se borran y se crean otra vez.
- No tiene varias plantillas de horario ni horario por sede.
- No lo lee Reservas (restaurante, con sus propias franjas y fechas bloqueadas), ni Reserva online,
  ni Personal; tampoco la receta de cita de WhatsApp, que pregunta a Citas.

## Dudas abiertas
- ¿Se puede editar un día especial o un cambio temporal en pantalla? Hoy se borra y se crea otra vez, y la fecha del borrado no vuelve a estar libre (decisión con `market-decision`).
- ¿Guardar **un solo día** debe dejar firmada toda la semana? Hoy apaga el aviso amarillo y el paso de puesta en marcha aunque los otros seis días sigan siendo los que puso el instalador.
- ¿Se ofrece un calendario de festivos del país precargado (Odoo y Business Central traen uno)?
- ¿Debe un restaurante usar Horarios? Su QA (`qa-hub-restaurant` §01) espera horarios, turno partido y festivo en la configuración del negocio, y Reservas tiene franjas propias; ninguna lectura enlaza los dos.
- ¿Se avisa al crear un cambio temporal que pisa un día especial ya existente?

## Fuentes contrastadas
Contra el código de `origin/main` (v2.0.48), una línea por discrepancia:
- `docs/overview.md`, `docs/limits.md`, `README.md` y `architecture/modules/schedules.md` dicen que ningún módulo depende de Horarios y que las citas tienen su propio horario; Citas lo declara en su manifest (`schedules` ≥ 2.0.28), lee sus cuatro listas y es su único consumidor (SCHEDULES-F11).
- `hand-book/modulos/schedules.md` dice «no debe suponerse» que Citas copie este horario; lo lee y rechaza fuera de él. Reservas, sí, tiene reglas propias.
- `docs/concepts.md` dice que la comprobación de «ya existe» se hace contra la lista que manda quien llama y da un fallo de bajo nivel; el servidor la lee por sí mismo antes de escribir (SCHEDULES-F04).
- `docs/concepts.md` dice que hay exactamente una fila por día de la semana y que guardar un día revive la fila borrada; hay una fila por tramo y guardar borra las anteriores y escribe filas nuevas (SCHEDULES-F02). Solo los ajustes reviven la fila.
- `docs/overview.md` habla de un ajuste de cierre automático con un `TODO: verify`; se retiró (SCHEDULES-F08).
- `docs/limits.md` dice que no se pueden consultar momentos puntuales; `is_open` contesta cualquiera (SCHEDULES-F10). Su fila de `invalid_hours` dice que el cierre ha de ser posterior a la apertura; con tramos, un cierre anterior pasa de medianoche.
- `locales/es.json`: «Esas horas no son válidas: … el cierre debe ser posterior a la apertura» se enseña también cuando un tramo tiene apertura y cierre iguales, y contradice el 22:00–02:00 que la pantalla admite; `schedules.overlapping` habla de tramos y sale también cuando dos cambios temporales se pisan (SCHEDULES-F05).
- `locales/es.json` trae `tabHours` («Horas»), `tabSpecialDays`, `tabSettings`, `colBreak`, `fieldBreakStart` y otras claves que ninguna pantalla usa; las pestañas se llaman «Horario», «Días especiales» y «Ajustes» (de `navigation`). «Sin horario configurado.» nunca se enseña (SCHEDULES-F01).
- `architecture/modules/schedules.md` dice que los rechazos salen como texto «codigo: detalle» y que la pestaña «Horas» lleva un descanso; desde schedules#28 son códigos con traducción y el descanso se sustituyó por tramos. Da `name(eq)` y `reason(eq)` como filtros; el manifest los declara como «contiene».
- `architecture/modules/schedules.md` dice que el importador de `.blueprint.zip` duplica la semana (hub#1535): tomado del documento, sin contrastar con el código del hub.
- La cabecera de `handler/src/lib.rs` aún dice que las filas del motor viajan en el payload; hoy las pre-carga el servidor y el esquema no deja mandarlas. `module.json` titula el paso de puesta en marcha «Confirm your opening hours» y la pantalla española lo traduce «Confirma tu horario».
- `qa-hub-restaurant` §01 espera horarios del restaurante con festivo y cierre pasada la medianoche; ni el catálogo de arranque del restaurante ni Reservas usan Horarios. `qa-hub.md` §6 no tiene escenario propio del módulo: B-02 y BD-06 lo tocan de refilón.
- El índice de Citas decía que sin ninguna regla se reserva a cualquier hora: es cierto solo si no hay fila semanal y ninguna excepción cubre la fecha; corregido en la oleada 2 en el WORKFLOW de Citas (APPOINTMENTS-F02), que ahora cuenta las tres diferencias con SCHEDULES-F10.
- El texto en español de `appointments.availability_unavailable` en Citas habla de «los bloqueos de la agenda», aunque el código se usa también cuando no se puede leer el horario (SCHEDULES-F11).
- `module.json` de Horarios no declara cómo traducir una clave duplicada en `schedules.special_days.create`; por eso la fecha reutilizada no sale como «ya existe» (SCHEDULES-F04).
