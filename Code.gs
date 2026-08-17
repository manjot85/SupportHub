// ============================================================================
// SUPPORT HUB — Code.gs (clean rewrite, Option A)
// Compatible with your existing sheets: "Questions Tracker", "Answered",
// "Team Setup" (same columns, nothing reshuffled). Adds two new sheets that
// are created automatically on first run:
//   - "Audit Log"        : who did what, when, to which ticket
//   - "Deleted Records"  : soft-delete archive (admin deletes land here
//                          instead of vanishing forever)
//
// What changed vs the old version:
//   1. EVERY mutating function runs inside a script lock (LockService), so
//      two people acting on the same ticket at the same moment can no longer
//      collide (double-answer, answer-vs-delete, assign-vs-answer, etc).
//   2. Audit logging on every state change.
//   3. Soft delete: admin "delete" archives the full row to Deleted Records
//      before removing it from the live sheet.
//   4. Stale-write protection on admin edits: if the record changed after
//      the edit modal was opened, the save is rejected with a clear message.
//   5. Stronger server-side validation (question required, valid case link,
//      event-name check, roster-derived asker name — the client-sent display
//      name is no longer trusted for submissions).
//   6. Team Setup guards: duplicate emails rejected, and the last working
//      Admin account cannot be deleted or demoted.
//
// Login model (unchanged, per your choice): dropdown profile picker, no
// passwords for regular users; Admin password only gates Admin actions.
// ============================================================================

// ==========================================
// GLOBALS & CONSTANTS
// ==========================================
const SHEET_QUESTIONS  = "Questions Tracker";
const SHEET_ANSWERED   = "Answered";
const SHEET_TEAM       = "Team Setup";
const SHEET_AUDIT      = "Audit Log";
const SHEET_DELETED    = "Deleted Records";

// Titles that count as "Support" (supervisor-tier) even if Category isn't set to "Support"
const SUPERVISOR_TITLES = ["Manager", "Assistant Manager", "Supervisor", "Escalation Supervisor"];

// How long a near-identical submission is treated as an accidental duplicate.
const DUPLICATE_WINDOW_MS = 15000;

// How long a mutation will wait to acquire the write lock before giving up.
const LOCK_WAIT_MS = 30000;

// ---- Column maps (1-indexed, matches getRange) ----
// Columns 1-11 (Questions) and 1-12 (Answered) are the ORIGINAL layout and are
// left exactly where they were. Every newer field is appended at the end and
// backfilled by ensureSheetsExist()/ensure*Schema().
const Q_COL = {
  QUESTION: 1, EVENT: 2, ASKED_BY: 3, CREATED: 4, DUE: 5, PRIORITY: 6,
  HOURS_LEFT: 7, LINK: 8, ANSWER: 9, STATUS: 10, ASSIGNED: 11,
  TICKET_ID: 12, HOLD_REASON: 13, HOLD_SINCE: 14, HOLD_ACCUM: 15, ASKED_BY_EMAIL: 16,
  FOLLOWUP: 17
};
const Q_WIDTH = 17;

const A_COL = {
  QUESTION: 1, EVENT: 2, ASKED_BY: 3, CREATED: 4, ANSWERED: 5, PRIORITY: 6,
  TURNAROUND: 7, LINK: 8, ANSWER: 9, STATUS: 10, ANSWERED_BY: 11, READ_BY: 12,
  TICKET_ID: 13, HOLD_HOURS: 14, ASKED_BY_EMAIL: 15
};
const A_WIDTH = 15;

// Canonical status values — never write anything else into the Status columns.
const STATUS_OPEN = "Open";
const STATUS_HOLD = "Hold";
const STATUS_ANSWERED = "Answered";

// App-wide timezone: every date shown to users follows Central Time (CST/CDT).
const APP_TIMEZONE = 'America/Chicago';

function doGet() {
  ensureSheetsExist();
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Support Hub')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Optional convenience menu inside the bound Sheet.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Support Hub')
    .addItem('Run setup / migration', 'runManualSetup')
    .addToUi();
}
function runManualSetup() {
  ensureSheetsExist();
  SpreadsheetApp.getActiveSpreadsheet().toast('Setup complete - sheets are up to date.', 'Support Hub', 5);
}

// ==========================================
// CONCURRENCY: the single write-lock wrapper
// ==========================================
// Every function that WRITES to any sheet goes through this. It serializes
// all mutations app-wide so the classic races (two supervisors answering the
// same ticket, an answer landing while someone deletes the row above it,
// two admins editing the same roster row) cannot interleave mid-write.
function withLock(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS);
  } catch (e) {
    throw new Error("The system is busy handling another change right now. Please try again in a few seconds.");
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// SHEET SETUP & MIGRATIONS (idempotent)
// ==========================================
function ensureSheetsExist() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let qSheet = ss.getSheetByName(SHEET_QUESTIONS);
  if (!qSheet) {
    qSheet = ss.insertSheet(SHEET_QUESTIONS);
    qSheet.appendRow(["Question", "Event/Wedding Name", "Asked By", "Created", "Due Date & Time", "Auto Priority", "Hours Left", "Case / Event Link", "Answer", "Status", "Assigned To", "Ticket ID", "Hold Reason", "Hold Since", "Cumulative Hold Hours", "Asked By Email", "Is Follow Up"]);
  }
  ensureQuestionsSchema(qSheet);

  let aSheet = ss.getSheetByName(SHEET_ANSWERED);
  if (!aSheet) {
    aSheet = ss.insertSheet(SHEET_ANSWERED);
    aSheet.appendRow(["Question", "Event/Wedding Name", "Asked By", "Created", "Answered Date", "Auto Priority", "Turnaround Hours", "Case / Event Link", "Answer", "Status", "Answered By", "Read By", "Ticket ID", "Hold Hours Excluded", "Asked By Email"]);
  }
  ensureAnsweredSchema(aSheet);

  if (!ss.getSheetByName(SHEET_TEAM)) {
    const s = ss.insertSheet(SHEET_TEAM);
    // PasswordHash / PasswordSalt are only ever read/written server-side and are
    // NEVER returned by getTeamMembers().
    s.appendRow(["Name", "Title", "Status", "Category", "Email", "PasswordHash", "PasswordSalt"]);
  }

  ensureAuditSheet(ss);
  ensureDeletedSheet(ss);
}

function ensureAuditSheet(ss) {
  let s = ss.getSheetByName(SHEET_AUDIT);
  if (!s) {
    s = ss.insertSheet(SHEET_AUDIT);
    s.appendRow(["Timestamp", "Actor Email", "Actor Name", "Action", "Ticket ID", "Details"]);
    s.setFrozenRows(1);
  }
  return s;
}

function ensureDeletedSheet(ss) {
  let s = ss.getSheetByName(SHEET_DELETED);
  if (!s) {
    s = ss.insertSheet(SHEET_DELETED);
    s.appendRow(["Deleted At", "Deleted By", "Source Sheet", "Ticket ID", "Question", "Event", "Asked By", "Full Row Data (JSON)"]);
    s.setFrozenRows(1);
  }
  return s;
}

// One-time, idempotent migration for sheets created under the OLD (11-column) schema.
function ensureQuestionsSchema(sheet) {
  let lastCol = Math.max(sheet.getLastColumn(), 1);
  let headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  if (headers[Q_COL.TICKET_ID - 1] !== 'Ticket ID') {
    sheet.getRange(1, Q_COL.TICKET_ID, 1, 5).setValues([
      ["Ticket ID", "Hold Reason", "Hold Since", "Cumulative Hold Hours", "Asked By Email"]
    ]);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const idRange = sheet.getRange(2, Q_COL.TICKET_ID, lastRow - 1, 1);
      const ids = idRange.getValues().map(r => [r[0] ? r[0] : Utilities.getUuid()]);
      idRange.setValues(ids);

      const accumRange = sheet.getRange(2, Q_COL.HOLD_ACCUM, lastRow - 1, 1);
      const accum = accumRange.getValues().map(r => [(r[0] === "" || r[0] === null || isNaN(r[0])) ? 0 : r[0]]);
      accumRange.setValues(accum);
    }
  }

  lastCol = Math.max(sheet.getLastColumn(), 1);
  headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers[Q_COL.FOLLOWUP - 1] !== 'Is Follow Up') {
    sheet.getRange(1, Q_COL.FOLLOWUP).setValue("Is Follow Up");
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const range = sheet.getRange(2, Q_COL.FOLLOWUP, lastRow - 1, 1);
      const vals = range.getValues().map(r => [r[0] === true]);
      range.setValues(vals);
    }
  }
}

function ensureAnsweredSchema(sheet) {
  let lastCol = Math.max(sheet.getLastColumn(), 1);
  let headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  if (headers[A_COL.TICKET_ID - 1] !== 'Ticket ID') {
    sheet.getRange(1, A_COL.TICKET_ID, 1, 2).setValues([["Ticket ID", "Hold Hours Excluded"]]);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const idRange = sheet.getRange(2, A_COL.TICKET_ID, lastRow - 1, 1);
      const ids = idRange.getValues().map(r => [r[0] ? r[0] : Utilities.getUuid()]);
      idRange.setValues(ids);

      const holdRange = sheet.getRange(2, A_COL.HOLD_HOURS, lastRow - 1, 1);
      const hold = holdRange.getValues().map(r => [(r[0] === "" || r[0] === null || isNaN(r[0])) ? 0 : r[0]]);
      holdRange.setValues(hold);
    }
  }

  lastCol = Math.max(sheet.getLastColumn(), 1);
  headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers[A_COL.ASKED_BY_EMAIL - 1] !== 'Asked By Email') {
    sheet.getRange(1, A_COL.ASKED_BY_EMAIL).setValue("Asked By Email");
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const range = sheet.getRange(2, A_COL.ASKED_BY_EMAIL, lastRow - 1, 1);
      const vals = range.getValues().map(r => [r[0] || ""]);
      range.setValues(vals);
    }
  }
}

// ==========================================
// AUDIT LOG & SOFT-DELETE ARCHIVE
// ==========================================
// Best-effort: an audit failure must never block the underlying action.
function logAudit(action, actorEmail, actorName, ticketId, details) {
  try {
    const s = ensureAuditSheet(SpreadsheetApp.getActiveSpreadsheet());
    s.appendRow([
      new Date(),
      String(actorEmail || '').trim().toLowerCase(),
      String(actorName || '').trim(),
      String(action || ''),
      String(ticketId || ''),
      typeof details === 'string' ? details : JSON.stringify(details || {})
    ]);
  } catch (e) {
    Logger.log('Audit log failed: ' + e);
  }
}

// Archives the full row into "Deleted Records" so an admin delete is recoverable.
function archiveDeletedRow(sourceSheetName, rowValues, ticketId, deletedByEmail) {
  const s = ensureDeletedSheet(SpreadsheetApp.getActiveSpreadsheet());
  s.appendRow([
    new Date(),
    String(deletedByEmail || '').trim().toLowerCase(),
    sourceSheetName,
    String(ticketId || ''),
    String(rowValues[0] || ''),           // Question
    String(rowValues[1] || ''),           // Event
    String(rowValues[2] || ''),           // Asked By
    JSON.stringify(rowValues)
  ]);
}

// ==========================================
// ROLE / AUTH HELPERS
// ==========================================
// NOTE: This app deliberately has NO real authentication (your choice - it's
// an internal, non-sensitive tool). "Login" is a dropdown profile picker on
// the client. The server still re-derives the caller's ROLE from the Team
// Setup sheet on every privileged call, so a Coordinator profile can't run
// Support/Admin actions - but claimed identity itself is honor-system.

function isSupportMember(member) {
  if (!member) return false;
  if (String(member.status).toLowerCase() !== 'active') return false;
  return member.category === 'Support' || member.category === 'Admin' || SUPERVISOR_TITLES.indexOf(member.title) !== -1;
}

function isAdminMember(member) {
  if (!member) return false;
  if (String(member.status).toLowerCase() !== 'active') return false;
  return member.category === 'Admin';
}

function findTeamMemberByEmail(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return null;
  const team = getTeamMembers();
  return team.find(m => m.email === email) || null;
}

function requireTeamMember(email) {
  const member = findTeamMemberByEmail(email);
  if (!member) throw new Error("Access denied: unrecognized or inactive user.");
  return member;
}

function requireSupportRole(email) {
  const member = requireTeamMember(email);
  if (!isSupportMember(member)) {
    throw new Error("Access denied: this action requires a Supervisor / Support role.");
  }
  return member;
}

function requireAdminRole(email) {
  const member = requireTeamMember(email);
  if (!isAdminMember(member)) {
    throw new Error("Access denied: this action requires the Admin role.");
  }
  return member;
}

function getTeamMembers() {
  ensureSheetsExist();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_TEAM);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  let team = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && String(data[i][0]).trim() !== "") {
      team.push({
        name: String(data[i][0]).trim(),
        title: String(data[i][1]).trim(),
        status: String(data[i][2]).trim(),
        category: String(data[i][3]).trim(),
        email: String(data[i][4]).trim().toLowerCase()
        // PasswordHash / PasswordSalt are deliberately omitted - this backs the
        // login dropdown and is callable before anyone is "logged in".
      });
    }
  }
  return team;
}

// ---- Password hashing (Admin accounts only) ----
function hashPassword(password, salt) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password) + '::' + String(salt));
  return Utilities.base64Encode(digest);
}

// Counts Admins that can actually log in (active + a password has been set).
function countWorkingAdmins() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_TEAM);
  if (!sheet) return 0;
  const data = sheet.getDataRange().getValues();
  let count = 0;
  for (let i = 1; i < data.length; i++) {
    const category = String(data[i][3] || '').trim();
    const status = String(data[i][2] || '').trim().toLowerCase();
    const passwordHash = String(data[i][5] || '').trim();
    if (category === 'Admin' && status === 'active' && passwordHash) count++;
  }
  return count;
}

// Server-only: includes hash/salt. Never expose this return value to the client.
function getTeamMemberRawByEmail(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return null;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_TEAM);
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][4]).trim().toLowerCase() === email) {
      return {
        rowIndex: i + 1,
        name: String(data[i][0]).trim(),
        title: String(data[i][1]).trim(),
        status: String(data[i][2]).trim(),
        category: String(data[i][3]).trim(),
        email: email,
        passwordHash: String(data[i][5] || '').trim(),
        passwordSalt: String(data[i][6] || '').trim()
      };
    }
  }
  return null;
}

function verifyAdminPassword(email, passwordAttempt) {
  const member = getTeamMemberRawByEmail(email);
  if (!member || String(member.status).toLowerCase() !== 'active') {
    throw new Error("Access denied: unrecognized or inactive user.");
  }
  if (member.category !== 'Admin') {
    throw new Error("This account is not an Admin account.");
  }
  if (!member.passwordHash) {
    throw new Error("This Admin account has no password set yet. Ask another Admin to set one in Team Setup.");
  }
  const attemptHash = hashPassword(passwordAttempt, member.passwordSalt);
  if (attemptHash !== member.passwordHash) {
    logAudit('ADMIN_LOGIN_FAILED', email, member.name, '', 'Incorrect password attempt');
    throw new Error("Incorrect password.");
  }
  logAudit('ADMIN_LOGIN', email, member.name, '', 'Admin password verified');
  return { success: true };
}

// ==========================================
// DATE / MISC HELPERS
// ==========================================
function safeIsoDate(val) {
  if (!val) return new Date().toISOString();
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString();
  }
  try {
    const parsed = new Date(val);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  } catch (e) {}
  return new Date().toISOString();
}

function formatCSTStamp(date) {
  return Utilities.formatDate(date || new Date(), APP_TIMEZONE, "MMM d, h:mm a");
}

// ==========================================
// VALIDATION HELPERS (server-side, always enforced)
// ==========================================
const EVENT_NAME_INVALID_MSG = "That doesn't look like a name - please re-enter the Event/Client/Talent name as text, or put NA if no event or contact is available/connected.";
function isValidEventName(text) {
  var value = String(text || '').trim();
  if (!value) return false;

  // Reject if the user pasted an actual web URL into the name field
  var isUrl = /^(https?:\/\/|www\.)/i.test(value) || /:\/\//.test(value) || /^(ftp|file):\/\//i.test(value);

  if (isUrl) return false;

  // Accept ANY other text string, naming convention, or character set
  return true;
}

function isValidCaseLink(text) {
  const value = String(text || '').trim();
  return /^https?:\/\/\S+$/i.test(value);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ==========================================
// TICKET-ID ROW RESOLUTION
// ==========================================
// EVERY mutation resolves a ticket's CURRENT row from its permanent Ticket ID
// right before acting (inside the lock), never from a client-cached row number.
function findRowIndexByTicketId(sheet, ticketId, ticketIdColumn) {
  const id = String(ticketId || '').trim();
  if (!id) return -1;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, ticketIdColumn, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === id) return i + 2;
  }
  return -1;
}

function requireQuestionRow(ticketId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_QUESTIONS);
  const rowIndex = findRowIndexByTicketId(sheet, ticketId, Q_COL.TICKET_ID);
  if (rowIndex === -1) {
    throw new Error("This ticket is no longer open - it may have just been answered or removed by someone else. Refresh to see its current state.");
  }
  return { sheet: sheet, rowIndex: rowIndex };
}

function requireAnsweredRow(ticketId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_ANSWERED);
  const rowIndex = findRowIndexByTicketId(sheet, ticketId, A_COL.TICKET_ID);
  if (rowIndex === -1) {
    throw new Error("This ticket record no longer exists - it may have just been edited or deleted by someone else. Refresh to see its current state.");
  }
  return { sheet: sheet, rowIndex: rowIndex };
}

// ==========================================
// HOLD-AWARE ELAPSED-TIME MATH
// ==========================================
function calculateWorkingHours(created, holdSinceVal, cumulativeHoldHours) {
  const now = new Date();
  let totalElapsed = Math.max(0, (now - created) / (1000 * 60 * 60));
  let holdHours = Number(cumulativeHoldHours) || 0;

  if (holdSinceVal) {
    const holdSince = (holdSinceVal instanceof Date) ? holdSinceVal : new Date(holdSinceVal);
    if (!isNaN(holdSince.getTime())) {
      holdHours += Math.max(0, (now - holdSince) / (1000 * 60 * 60));
    }
  }
  return Math.max(0, totalElapsed - holdHours);
}

function calculatePriorityAndHours(createdVal, forcedPriority, holdSinceVal, cumulativeHoldHours) {
  if (!createdVal) return { priority: "P4", hoursElapsed: "0.0" };
  let created = (createdVal instanceof Date) ? createdVal : new Date(createdVal);
  if (isNaN(created.getTime())) return { priority: "P4", hoursElapsed: "0.0" };

  const workingHours = calculateWorkingHours(created, holdSinceVal, cumulativeHoldHours);
  const hoursElapsed = workingHours.toFixed(1);

  const forced = String(forcedPriority || '').trim().toUpperCase();
  if (forced === 'P1' || forced === 'URGENT') {
    return { priority: "P1", hoursElapsed: hoursElapsed };
  }

  let priority = "P4";
  if (workingHours >= 6) priority = "P1";
  else if (workingHours >= 3) priority = "P2";
  else if (workingHours >= 1) priority = "P3";

  return { priority: priority, hoursElapsed: hoursElapsed };
}

// ---- Per-user "Read By" helpers ----
function parseReadByList(raw) {
  if (raw === true) return ['*'];
  if (!raw) return [];
  return String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function isReadByUser(raw, email) {
  const list = parseReadByList(raw);
  if (list.indexOf('*') !== -1) return true;
  return list.indexOf(String(email || '').trim().toLowerCase()) !== -1;
}

// ==========================================
// READ: main data feed
// ==========================================
function getQuestionsData(requestingEmail) {
  ensureSheetsExist();
  requireTeamMember(requestingEmail);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const qSheet = ss.getSheetByName(SHEET_QUESTIONS);
  const aSheet = ss.getSheetByName(SHEET_ANSWERED);

  let records = [];

  try {
    if (qSheet && qSheet.getLastRow() > 1) {
      const qData = qSheet.getDataRange().getValues();
      for (let i = 1; i < qData.length; i++) {
        const row = qData[i];
        const qText = String(row[0] || "").trim();
        if (!qText) continue;

        const ticketId = String(row[Q_COL.TICKET_ID - 1] || "").trim();
        const holdSinceRaw = row[Q_COL.HOLD_SINCE - 1];
        const cumulativeHold = Number(row[Q_COL.HOLD_ACCUM - 1]) || 0;
        const createdIso = safeIsoDate(row[3]);
        const prioInfo = calculatePriorityAndHours(row[3], row[5], holdSinceRaw, cumulativeHold);

        records.push({
          id: "Q_" + (ticketId || (i + 1)),
          ticketId: ticketId,
          sheet: SHEET_QUESTIONS,
          question: qText,
          eventName: String(row[1] || "").trim(),
          askedBy: String(row[2] || "").trim(),
          askedByEmail: String(row[Q_COL.ASKED_BY_EMAIL - 1] || "").trim().toLowerCase(),
          created: createdIso,
          caseLink: String(row[7] || "").trim(),
          answer: String(row[8] || "").trim(),
          status: String(row[9] || STATUS_OPEN).trim(),
          assignedTo: String(row[10] || "").trim().toLowerCase(),
          priority: prioInfo.priority,
          hoursElapsed: prioInfo.hoursElapsed,
          holdReason: String(row[Q_COL.HOLD_REASON - 1] || "").trim(),
          holdSince: holdSinceRaw ? safeIsoDate(holdSinceRaw) : "",
          isFollowUp: row[Q_COL.FOLLOWUP - 1] === true,
          isRead: true
        });
      }
    }

    if (aSheet && aSheet.getLastRow() > 1) {
      const aData = aSheet.getDataRange().getValues();
      for (let i = 1; i < aData.length; i++) {
        const row = aData[i];
        const qText = String(row[0] || "").trim();
        if (!qText) continue;

        const ticketId = String(row[A_COL.TICKET_ID - 1] || "").trim();
        const createdIso = safeIsoDate(row[3]);
        const answeredIso = safeIsoDate(row[4]);

        let turnaround = row[6];
        if (turnaround === "" || turnaround === undefined || isNaN(turnaround) || Number(turnaround) < 0) {
          const cDate = new Date(createdIso);
          const aDate = new Date(answeredIso);
          const diff = (aDate - cDate) / (1000 * 60 * 60);
          turnaround = diff > 0 ? diff.toFixed(1) : "0.5";
        } else {
          turnaround = Math.abs(Number(turnaround)).toFixed(1);
        }

        records.push({
          id: "A_" + (ticketId || (i + 1)),
          ticketId: ticketId,
          sheet: SHEET_ANSWERED,
          question: qText,
          eventName: String(row[1] || "").trim(),
          askedBy: String(row[2] || "").trim(),
          askedByEmail: String(row[A_COL.ASKED_BY_EMAIL - 1] || "").trim().toLowerCase(),
          created: createdIso,
          answeredDate: answeredIso,
          turnaroundHours: turnaround,
          holdHoursExcluded: Number(row[A_COL.HOLD_HOURS - 1]) || 0,
          caseLink: String(row[7] || "").trim(),
          answer: String(row[8] || "").trim(),
          status: String(row[9] || STATUS_ANSWERED).trim(),
          answeredBy: String(row[10] || "Supervisor").trim(),
          priority: String(row[5] || "Resolved").trim(),
          hoursElapsed: 0,
          isRead: isReadByUser(row[11], requestingEmail)
        });
      }
    }
  } catch (err) {
    Logger.log("Error in getQuestionsData: " + err.toString());
  }

  return records;
}

// Rejects a near-identical (question + event + asker) submission arriving within
// DUPLICATE_WINDOW_MS - catches accidental double-clicks.
function isDuplicateSubmission(sheet, question, eventName, askedByName) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const startRow = Math.max(2, lastRow - 9);
  const numRows = lastRow - startRow + 1;
  const data = sheet.getRange(startRow, 1, numRows, 4).getValues();
  const now = new Date();
  const normQ = String(question || '').trim().toLowerCase();
  const normE = String(eventName || '').trim().toLowerCase();
  const normA = String(askedByName || '').trim().toLowerCase();

  for (let i = 0; i < data.length; i++) {
    const rQ = String(data[i][0] || '').trim().toLowerCase();
    const rE = String(data[i][1] || '').trim().toLowerCase();
    const rA = String(data[i][2] || '').trim().toLowerCase();
    const rCreated = data[i][3];
    if (rQ === normQ && rE === normE && rA === normA && rCreated instanceof Date) {
      const ageMs = now - rCreated;
      if (ageMs >= 0 && ageMs < DUPLICATE_WINDOW_MS) return true;
    }
  }
  return false;
}

// ==========================================
// MUTATIONS (all wrapped in withLock)
// ==========================================

function submitQuestion(payload) {
  return withLock(() => {
    ensureSheetsExist();
    payload = payload || {};

    const member = requireTeamMember(payload.askedByEmail);
    const question = String(payload.question || '').trim();
    const eventName = String(payload.eventName || '').trim();
    const caseLink = String(payload.caseLink || '').trim();
    const assignedToEmail = String(payload.assignedToEmail || '').trim().toLowerCase();

    if (!question) throw new Error("Please describe your question before submitting.");
    if (!isValidEventName(eventName)) throw new Error(EVENT_NAME_INVALID_MSG);
    if (!isValidCaseLink(caseLink)) throw new Error("Please provide a valid Case / Event URL.");

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_QUESTIONS);

    if (isDuplicateSubmission(sheet, question, eventName, member.name)) {
      return { success: false, duplicate: true, message: "This looks like a duplicate submission." };
    }

    const now = new Date();
    const ticketId = Utilities.getUuid();

    // Append Row Structure:
    // [Question, EventName, AskedBy, Created, Answer, Priority, HoldReason, CaseLink, HoldStart, Status, AssignedToEmail, TicketId, ...]
    sheet.appendRow([
      question,
      eventName,
      member.name,
      now,
      "",
      payload.isUrgent ? "P1" : "",
      "",
      caseLink,
      "",
      STATUS_OPEN,
      assignedToEmail, // Direct assignment to @mentioned staff email
      ticketId,
      "",
      "",
      0,
      member.email,
      false
    ]);

    logAudit('SUBMIT', member.email, member.name, ticketId, { 
      event: eventName, 
      urgent: !!payload.isUrgent, 
      assignedTo: assignedToEmail 
    });
    
    return { success: true, ticketId: ticketId };
  });
}

function answerQuestion(ticketId, answerText, supervisorEmail, supervisorName) {
  return withLock(() => {
    const supervisor = requireSupportRole(supervisorEmail);
    const answer = String(answerText || '').trim();
    if (!answer) throw new Error("Please write an answer before submitting.");

    // Row is resolved INSIDE the lock - if someone else answered/deleted this
    // ticket a moment ago, this throws a clean "no longer open" message
    // instead of acting on the wrong row.
    const target = requireQuestionRow(ticketId);
    const qSheet = target.sheet;
    const rowIndex = target.rowIndex;

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const aSheet = ss.getSheetByName(SHEET_ANSWERED);

    const rowData = qSheet.getRange(rowIndex, 1, 1, Q_WIDTH).getValues()[0];
    const now = new Date();
    const createdDate = rowData[Q_COL.CREATED - 1] ? new Date(rowData[Q_COL.CREATED - 1]) : now;

    // If still on Hold when answered, close out the open hold period so its
    // duration stays excluded from turnaround.
    let cumulativeHold = Number(rowData[Q_COL.HOLD_ACCUM - 1]) || 0;
    const holdSinceVal = rowData[Q_COL.HOLD_SINCE - 1];
    if (holdSinceVal) {
      const holdSince = (holdSinceVal instanceof Date) ? holdSinceVal : new Date(holdSinceVal);
      if (!isNaN(holdSince.getTime())) {
        cumulativeHold += Math.max(0, (now - holdSince) / (1000 * 60 * 60));
      }
    }

    const totalElapsedHours = Math.max(0, (now - createdDate) / (1000 * 60 * 60));
    const turnaroundHours = Math.max(0.1, totalElapsedHours - cumulativeHold).toFixed(1);

    aSheet.appendRow([
      rowData[Q_COL.QUESTION - 1],
      rowData[Q_COL.EVENT - 1],
      rowData[Q_COL.ASKED_BY - 1],
      rowData[Q_COL.CREATED - 1],
      now,
      "Resolved",
      turnaroundHours,
      rowData[Q_COL.LINK - 1],
      answer,
      STATUS_ANSWERED,
      supervisor.name,           // roster-derived, not client-supplied
      "",                        // Read By - unread for everyone until each person opens it
      rowData[Q_COL.TICKET_ID - 1],
      cumulativeHold.toFixed(2),
      rowData[Q_COL.ASKED_BY_EMAIL - 1] || ""
    ]);

    qSheet.deleteRow(rowIndex);
    logAudit('ANSWER', supervisor.email, supervisor.name, ticketId, { turnaroundHours: turnaroundHours });
    return { success: true };
  });
}

function holdQuestion(ticketId, reason, requestingEmail) {
  return withLock(() => {
    const member = requireSupportRole(requestingEmail);
    const target = requireQuestionRow(ticketId);
    const sheet = target.sheet;
    const rowIndex = target.rowIndex;

    const current = sheet.getRange(rowIndex, 1, 1, Q_WIDTH).getValues()[0];
    const alreadyOnHold = !!current[Q_COL.HOLD_SINCE - 1];

    sheet.getRange(rowIndex, Q_COL.HOLD_REASON).setValue(String(reason || '').trim());
    if (!alreadyOnHold) {
      sheet.getRange(rowIndex, Q_COL.STATUS).setValue(STATUS_HOLD);
      sheet.getRange(rowIndex, Q_COL.HOLD_SINCE).setValue(new Date());
    }
    logAudit(alreadyOnHold ? 'HOLD_REASON_UPDATED' : 'HOLD', member.email, member.name, ticketId, { reason: String(reason || '').trim() });
    return { success: true };
  });
}

function resumeQuestion(ticketId, requestingEmail) {
  return withLock(() => {
    const member = requireSupportRole(requestingEmail);
    const target = requireQuestionRow(ticketId);
    const sheet = target.sheet;
    const rowIndex = target.rowIndex;

    const current = sheet.getRange(rowIndex, 1, 1, Q_WIDTH).getValues()[0];
    const holdSinceVal = current[Q_COL.HOLD_SINCE - 1];
    if (!holdSinceVal) return { success: true };

    const holdSince = (holdSinceVal instanceof Date) ? holdSinceVal : new Date(holdSinceVal);
    const now = new Date();
    const elapsedHours = isNaN(holdSince.getTime()) ? 0 : Math.max(0, (now - holdSince) / (1000 * 60 * 60));
    const newCumulative = (Number(current[Q_COL.HOLD_ACCUM - 1]) || 0) + elapsedHours;

    sheet.getRange(rowIndex, Q_COL.STATUS).setValue(STATUS_OPEN);
    sheet.getRange(rowIndex, Q_COL.HOLD_REASON).setValue("");
    sheet.getRange(rowIndex, Q_COL.HOLD_SINCE).setValue("");
    sheet.getRange(rowIndex, Q_COL.HOLD_ACCUM).setValue(newCumulative);
    logAudit('RESUME', member.email, member.name, ticketId, { holdHoursAdded: elapsedHours.toFixed(2) });
    return { success: true };
  });
}

function addQuestionUpdate(ticketId, updateText, requestingEmail) {
  return withLock(() => {
    const member = requireTeamMember(requestingEmail);
    const text = String(updateText || '').trim();
    if (!text) throw new Error("Please enter some update text.");

    const target = requireQuestionRow(ticketId);
    const sheet = target.sheet;
    const rowIndex = target.rowIndex;

    const current = sheet.getRange(rowIndex, 1, 1, Q_WIDTH).getValues()[0];
    const askedByName = String(current[Q_COL.ASKED_BY - 1] || '').trim();
    const askedByEmail = String(current[Q_COL.ASKED_BY_EMAIL - 1] || '').trim().toLowerCase();
    const reqEmail = normalizeEmail(requestingEmail);

    const isOwner = askedByEmail
      ? askedByEmail === reqEmail
      : askedByName.toLowerCase() === String(member.name || '').trim().toLowerCase();

    if (!isOwner && !isSupportMember(member)) {
      throw new Error("Access denied: you can only add updates to your own tickets.");
    }

    const stamp = formatCSTStamp(new Date());
    const newQuestion = String(current[Q_COL.QUESTION - 1] || '') + "\n\n[Update " + stamp + " CST by " + member.name + "]: " + text;
    sheet.getRange(rowIndex, Q_COL.QUESTION).setValue(newQuestion);
    logAudit('ADD_UPDATE', member.email, member.name, ticketId, { textLength: text.length });
    return { success: true };
  });
}

function reopenAnsweredTicket(ticketId, updateText, requestingEmail) {
  return withLock(() => {
    const member = requireTeamMember(requestingEmail);
    const text = String(updateText || '').trim();
    if (!text) throw new Error("Please describe the follow-up before reopening this ticket.");

    const target = requireAnsweredRow(ticketId);
    const aSheet = target.sheet;
    const rowIndex = target.rowIndex;
    const current = aSheet.getRange(rowIndex, 1, 1, A_WIDTH).getValues()[0];

    const askedByName = String(current[A_COL.ASKED_BY - 1] || '').trim();
    const askedByEmail = String(current[A_COL.ASKED_BY_EMAIL - 1] || '').trim().toLowerCase();
    const reqEmail = normalizeEmail(requestingEmail);
    const isOwner = askedByEmail
      ? askedByEmail === reqEmail
      : askedByName.toLowerCase() === String(member.name || '').trim().toLowerCase();

    if (!isOwner && !isSupportMember(member)) {
      throw new Error("Access denied: only the original asker or a Support/Supervisor can reopen this ticket.");
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const qSheet = ss.getSheetByName(SHEET_QUESTIONS);

    const stamp = formatCSTStamp(new Date());
    const previousAnswer = String(current[A_COL.ANSWER - 1] || '').trim();
    const previousAnsweredBy = String(current[A_COL.ANSWERED_BY - 1] || 'Supervisor').trim();
    const combinedQuestion =
      String(current[A_COL.QUESTION - 1] || '').trim() +
      "\n\n[Previous Answer by " + previousAnsweredBy + "]: " + previousAnswer +
      "\n\n[Follow-Up " + stamp + " CST by " + member.name + "]: " + text;

    const now = new Date();
    const newTicketId = Utilities.getUuid();

    qSheet.appendRow([
      combinedQuestion,
      current[A_COL.EVENT - 1],
      current[A_COL.ASKED_BY - 1],
      now,
      "",
      "",
      "",
      current[A_COL.LINK - 1],
      "",
      STATUS_OPEN,
      "",
      newTicketId,
      "",
      "",
      0,
      askedByEmail || "",
      true
    ]);

    aSheet.deleteRow(rowIndex);
    logAudit('REOPEN', member.email, member.name, newTicketId, { previousTicketId: String(ticketId || '') });
    return { success: true, ticketId: newTicketId };
  });
}

function assignQuestion(ticketId, assigneeEmail, requestingEmail) {
  return withLock(() => {
    const requester = requireSupportRole(requestingEmail);
    const assignee = requireSupportRole(assigneeEmail);
    const target = requireQuestionRow(ticketId);
    target.sheet.getRange(target.rowIndex, Q_COL.ASSIGNED).setValue(assignee.email);
    logAudit('ASSIGN', requester.email, requester.name, ticketId, { assignedTo: assignee.email });
    return { success: true };
  });
}

function assignQuestionsBulk(ticketIds, assigneeEmail, requestingEmail) {
  return withLock(() => {
    const requester = requireSupportRole(requestingEmail);
    const assignee = requireSupportRole(assigneeEmail);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const qSheet = ss.getSheetByName(SHEET_QUESTIONS);
    let updated = 0;

    (ticketIds || []).forEach(id => {
      const rowIndex = findRowIndexByTicketId(qSheet, id, Q_COL.TICKET_ID);
      if (rowIndex !== -1) {
        qSheet.getRange(rowIndex, Q_COL.ASSIGNED).setValue(assignee.email);
        updated++;
      }
    });

    logAudit('ASSIGN_BULK', requester.email, requester.name, '', { assignedTo: assignee.email, count: updated });
    return { success: true, updated: updated };
  });
}

function unassignQuestion(ticketId, requestingEmail) {
  return withLock(() => {
    const requester = requireSupportRole(requestingEmail);
    const target = requireQuestionRow(ticketId);
    target.sheet.getRange(target.rowIndex, Q_COL.ASSIGNED).setValue("");
    logAudit('UNASSIGN', requester.email, requester.name, ticketId, {});
    return { success: true };
  });
}

function toggleReadStatus(ticketId, isRead, requestingEmail) {
  return withLock(() => {
    requireTeamMember(requestingEmail);
    const email = normalizeEmail(requestingEmail);
    const target = requireAnsweredRow(ticketId);

    const cell = target.sheet.getRange(target.rowIndex, A_COL.READ_BY);
    let list = parseReadByList(cell.getValue()).filter(e => e !== '*');
    if (isRead) {
      if (list.indexOf(email) === -1) list.push(email);
    } else {
      list = list.filter(e => e !== email);
    }
    cell.setValue(list.join(', '));
    return { success: true };
  });
}

// ==========================================
// TEAM ROSTER MANAGEMENT
// ==========================================
function saveTeamMember(member, requestingEmail) {
  return withLock(() => {
    ensureSheetsExist();
    member = member || {};
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_TEAM);

    const newEmail = normalizeEmail(member.email);
    const newName = String(member.name || '').trim();
    if (!newName) throw new Error("Name is required.");
    if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) throw new Error("A valid email address is required.");

    // Rows are looked up by the email the record had BEFORE this edit, never
    // by a client-cached row number.
    const originalEmail = normalizeEmail(member.originalEmail);
    const data = sheet.getDataRange().getValues();
    let targetRow = -1;
    if (originalEmail) {
      for (let i = 1; i < data.length; i++) {
        if (normalizeEmail(data[i][4]) === originalEmail) { targetRow = i + 1; break; }
      }
      if (targetRow === -1) throw new Error("This team member no longer exists - someone may have just removed them. Please refresh.");
    }

    // Duplicate-email guard: no other roster row may already use the new email.
    for (let i = 1; i < data.length; i++) {
      const rowEmail = normalizeEmail(data[i][4]);
      if (rowEmail === newEmail && (i + 1) !== targetRow) {
        throw new Error("Another team member already uses that email address.");
      }
    }

    const newCategory = String(member.category || '').trim();
    const newStatus = String(member.status || '').trim();
    const existingCategory = targetRow !== -1 ? String(sheet.getRange(targetRow, 4).getValue()).trim() : '';
    const touchesAdmin = newCategory === 'Admin' || existingCategory === 'Admin';

    if (touchesAdmin) {
      // Bootstrap exception: if there is no working Admin yet, any
      // Support/Supervisor may create the very first one.
      if (countWorkingAdmins() > 0) {
        requireAdminRole(requestingEmail);
      } else {
        requireSupportRole(requestingEmail);
      }
    } else {
      requireSupportRole(requestingEmail);
    }

    let passwordHash = '';
    let passwordSalt = '';
    let wasWorkingAdmin = false;
    if (targetRow !== -1) {
      const existing = sheet.getRange(targetRow, 1, 1, 7).getValues()[0];
      passwordHash = existing[5] || '';
      passwordSalt = existing[6] || '';
      wasWorkingAdmin = String(existing[3]).trim() === 'Admin'
        && String(existing[2]).trim().toLowerCase() === 'active'
        && !!String(existing[5] || '').trim();
    }

    // Last-working-Admin guard: an edit may not demote or deactivate the only
    // Admin who can still log in - that would lock everyone out of Admin.
    const losesAdminAbility = wasWorkingAdmin && (newCategory !== 'Admin' || newStatus.toLowerCase() !== 'active');
    if (losesAdminAbility && countWorkingAdmins() <= 1) {
      throw new Error("This is the last working Admin account - it cannot be demoted or deactivated. Create another Admin first.");
    }

    if (newCategory === 'Admin') {
      if (member.password) {
        passwordSalt = Utilities.getUuid();
        passwordHash = hashPassword(member.password, passwordSalt);
      }
      if (targetRow === -1 && !passwordHash) {
        throw new Error("A password is required when creating a new Admin account.");
      }
    } else {
      passwordHash = '';
      passwordSalt = '';
    }

    const actor = requireTeamMember(requestingEmail);
    const row = [newName, String(member.title || '').trim(), newStatus, newCategory, newEmail, passwordHash, passwordSalt];

    if (targetRow !== -1) {
      sheet.getRange(targetRow, 1, 1, 7).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
    logAudit(targetRow !== -1 ? 'TEAM_EDIT' : 'TEAM_ADD', actor.email, actor.name, '', { member: newEmail, category: newCategory, status: newStatus });
    return { success: true };
  });
}

function deleteTeamMember(email, requestingEmail) {
  return withLock(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_TEAM);
    const targetEmail = normalizeEmail(email);

    const data = sheet.getDataRange().getValues();
    let targetRow = -1;
    let targetCategory = '';
    let targetIsWorkingAdmin = false;
    for (let i = 1; i < data.length; i++) {
      if (normalizeEmail(data[i][4]) === targetEmail) {
        targetRow = i + 1;
        targetCategory = String(data[i][3]).trim();
        targetIsWorkingAdmin = targetCategory === 'Admin'
          && String(data[i][2]).trim().toLowerCase() === 'active'
          && !!String(data[i][5] || '').trim();
        break;
      }
    }
    if (targetRow === -1) throw new Error("This team member no longer exists - someone may have already removed them.");

    if (targetCategory === 'Admin') {
      if (countWorkingAdmins() > 0) {
        requireAdminRole(requestingEmail);
      } else {
        requireSupportRole(requestingEmail); // bootstrap: cleanup of a broken Admin row
      }
    } else {
      requireSupportRole(requestingEmail);
    }

    // Last-working-Admin guard.
    if (targetIsWorkingAdmin && countWorkingAdmins() <= 1) {
      throw new Error("This is the last working Admin account - it cannot be deleted. Create another Admin first.");
    }

    const actor = requireTeamMember(requestingEmail);
    sheet.deleteRow(targetRow);
    logAudit('TEAM_DELETE', actor.email, actor.name, '', { member: targetEmail });
    return { success: true };
  });
}

// ==========================================
// ADMIN-ONLY: EDIT / DELETE QUESTIONS & ANSWERS
// Deletes are SOFT: the full row is archived to "Deleted Records" first, so
// an accidental delete can always be recovered from that sheet.
// Edits carry stale-write protection: if the record changed after the edit
// modal was opened, the save is rejected instead of silently overwriting.
// ==========================================

function updateQuestion(ticketId, updates, requestingEmail) {
  return withLock(() => {
    const admin = requireAdminRole(requestingEmail);
    updates = updates || {};
    const target = requireQuestionRow(ticketId);
    const qSheet = target.sheet;
    const rowIndex = target.rowIndex;

    const current = qSheet.getRange(rowIndex, 1, 1, Q_WIDTH).getValues()[0];

    // Stale-write check: the client sends the question text it loaded when the
    // modal opened. If someone changed the record since, reject.
    if (updates.expected && updates.expected.question !== undefined) {
      if (String(current[Q_COL.QUESTION - 1] || '').trim() !== String(updates.expected.question || '').trim()) {
        throw new Error("This record changed after you opened it (someone else edited or updated it). Please refresh and try again.");
      }
    }

    if (updates.eventName !== undefined && !isValidEventName(updates.eventName)) {
      throw new Error(EVENT_NAME_INVALID_MSG);
    }
    if (updates.caseLink !== undefined && String(updates.caseLink || '').trim() && !isValidCaseLink(updates.caseLink)) {
      throw new Error("Please provide a valid Case / Event URL (it must start with http:// or https://).");
    }

    const merged = current.slice();
    if (updates.question !== undefined) merged[Q_COL.QUESTION - 1] = updates.question;
    if (updates.eventName !== undefined) merged[Q_COL.EVENT - 1] = updates.eventName;
    if (updates.askedBy !== undefined) merged[Q_COL.ASKED_BY - 1] = updates.askedBy;
    if (updates.isUrgent !== undefined) merged[Q_COL.PRIORITY - 1] = updates.isUrgent ? "P1" : "";
    if (updates.caseLink !== undefined) merged[Q_COL.LINK - 1] = updates.caseLink;
    // Created, Ticket ID, Hold fields, Assigned, and Asked By Email are never touched by an edit.

    qSheet.getRange(rowIndex, 1, 1, Q_WIDTH).setValues([merged]);
    logAudit('EDIT_QUESTION', admin.email, admin.name, ticketId, { fields: Object.keys(updates).filter(k => k !== 'expected') });
    return { success: true };
  });
}

function deleteQuestion(ticketId, requestingEmail) {
  return withLock(() => {
    const admin = requireAdminRole(requestingEmail);
    const target = requireQuestionRow(ticketId);
    const rowValues = target.sheet.getRange(target.rowIndex, 1, 1, Q_WIDTH).getValues()[0];
    archiveDeletedRow(SHEET_QUESTIONS, rowValues, ticketId, admin.email);
    target.sheet.deleteRow(target.rowIndex);
    logAudit('DELETE_QUESTION', admin.email, admin.name, ticketId, { archived: true });
    return { success: true };
  });
}

function updateAnswer(ticketId, updates, requestingEmail) {
  return withLock(() => {
    const admin = requireAdminRole(requestingEmail);
    updates = updates || {};
    const target = requireAnsweredRow(ticketId);
    const aSheet = target.sheet;
    const rowIndex = target.rowIndex;

    const current = aSheet.getRange(rowIndex, 1, 1, A_WIDTH).getValues()[0];

    if (updates.expected && updates.expected.question !== undefined) {
      const questionChanged = String(current[A_COL.QUESTION - 1] || '').trim() !== String(updates.expected.question || '').trim();
      const answerChanged = updates.expected.answer !== undefined
        && String(current[A_COL.ANSWER - 1] || '').trim() !== String(updates.expected.answer || '').trim();
      if (questionChanged || answerChanged) {
        throw new Error("This record changed after you opened it (someone else edited or updated it). Please refresh and try again.");
      }
    }

    if (updates.eventName !== undefined && !isValidEventName(updates.eventName)) {
      throw new Error(EVENT_NAME_INVALID_MSG);
    }
    if (updates.caseLink !== undefined && String(updates.caseLink || '').trim() && !isValidCaseLink(updates.caseLink)) {
      throw new Error("Please provide a valid Case / Event URL (it must start with http:// or https://).");
    }

    const merged = current.slice();
    if (updates.question !== undefined) merged[A_COL.QUESTION - 1] = updates.question;
    if (updates.eventName !== undefined) merged[A_COL.EVENT - 1] = updates.eventName;
    if (updates.askedBy !== undefined) merged[A_COL.ASKED_BY - 1] = updates.askedBy;
    if (updates.caseLink !== undefined) merged[A_COL.LINK - 1] = updates.caseLink;
    if (updates.answer !== undefined) merged[A_COL.ANSWER - 1] = updates.answer;
    if (updates.answeredBy !== undefined) merged[A_COL.ANSWERED_BY - 1] = updates.answeredBy;
    // Read By, Ticket ID, and Hold Hours Excluded are never touched by an edit.

    aSheet.getRange(rowIndex, 1, 1, A_WIDTH).setValues([merged]);
    logAudit('EDIT_ANSWER', admin.email, admin.name, ticketId, { fields: Object.keys(updates).filter(k => k !== 'expected') });
    return { success: true };
  });
}

function deleteAnswer(ticketId, requestingEmail) {
  return withLock(() => {
    const admin = requireAdminRole(requestingEmail);
    const target = requireAnsweredRow(ticketId);
    const rowValues = target.sheet.getRange(target.rowIndex, 1, 1, A_WIDTH).getValues()[0];
    archiveDeletedRow(SHEET_ANSWERED, rowValues, ticketId, admin.email);
    target.sheet.deleteRow(target.rowIndex);
    logAudit('DELETE_ANSWER', admin.email, admin.name, ticketId, { archived: true });
    return { success: true };
  });
}
