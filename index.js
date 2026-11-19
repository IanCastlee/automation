const SECRET = "ilagay-dito-ang-mahabang-random-na-text";
const ROOMS = 3; // ilang kwarto ang pwedeng ibenta kada gabi
const SHEET_NAME = "Bookings";
const CALENDAR_NAME = "Resort Bookings";

function getCalendar_() {
  const found = CalendarApp.getCalendarsByName(CALENDAR_NAME);
  return found.length ? found[0] : CalendarApp.createCalendar(CALENDAR_NAME);
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow([
      "Timestamp",
      "Pangalan",
      "Telepono",
      "Check-in",
      "Check-out",
      "Bisita",
      "Telegram chat ID",
      "Status",
      "Event ID",
    ]);
  }
  return sh;
}

function parseDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) throw new Error("Maling petsa: " + s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function validateRange_(checkIn, checkOut) {
  const start = parseDate_(checkIn);
  const end = parseDate_(checkOut);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (start < today) throw new Error("Lumipas na ang check-in date.");
  if (end <= start)
    throw new Error("Dapat mas huli ang check-out kaysa check-in.");
  if ((end - start) / 86400000 > 30)
    throw new Error("Hanggang 30 gabi lang ang pwede.");
  return { start, end };
}

function checkAvailability_(checkIn, checkOut) {
  const { start, end } = validateRange_(checkIn, checkOut);
  const booked = getCalendar_().getEvents(start, end).length;
  return { available: booked < ROOMS, roomsLeft: Math.max(ROOMS - booked, 0) };
}

function createBooking_(d) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const avail = checkAvailability_(d.checkIn, d.checkOut);
    if (!avail.available)
      return { ok: false, error: "Wala nang bakante sa mga petsang iyon." };

    const { start, end } = validateRange_(d.checkIn, d.checkOut);
    const event = getCalendar_().createAllDayEvent(
      `[Pending] ${d.name} (${d.guests} bisita)`,
      start,
      end,
      { description: `Tel: ${d.phone}\nTelegram chat ID: ${d.chatId}` },
    );
    getSheet_().appendRow([
      new Date(),
      d.name,
      d.phone,
      d.checkIn,
      d.checkOut,
      d.guests,
      d.chatId,
      "Pending",
      event.getId(),
    ]);
    return { ok: true, message: "Na-save ang booking bilang Pending." };
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET)
      return json_({ ok: false, error: "unauthorized" });
    if (body.action === "check")
      return json_({
        ok: true,
        ...checkAvailability_(body.checkIn, body.checkOut),
      });
    if (body.action === "book") return json_(createBooking_(body));
    return json_({ ok: false, error: "unknown action" });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

// Pang-test sa editor
function testCheck() {
  Logger.log(JSON.stringify(checkAvailability_("2026-12-20", "2026-12-22")));
}
function testBook() {
  Logger.log(
    JSON.stringify(
      createBooking_({
        name: "Test Guest",
        phone: "09000000000",
        checkIn: "2026-12-20",
        checkOut: "2026-12-22",
        guests: 2,
        chatId: "test",
      }),
    ),
  );
}
