const express = require('express');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
 
const app = express();
const PORT = process.env.PORT || 3000;
const EDIT_PIN = process.env.EDIT_PIN || '011216';
 
app.use(cors());
app.use(express.json());
const fs = require('fs');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
app.use(express.static(fs.existsSync(PUBLIC_DIR) ? PUBLIC_DIR : __dirname));
 
// ── MongoDB Connection ─────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
let db;
 
async function connectDB() {
  if (!MONGO_URI) { console.error('❌ MONGO_URI nahi hai!'); process.exit(1); }
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('maswer_attend');
  console.log('✅ MongoDB connected!');
  const emps = db.collection('employees');
  const count = await emps.countDocuments();
  if (count === 0) {
    await emps.insertOne({ id: 'MW113761', name: 'Vivek Singh', mobile: '8146162102', role: 'admin', createdAt: new Date().toISOString() });
    console.log('✅ Default admin seeded.');
  }
}
 
// ── Helpers ────────────────────────────────────────────────
function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
function nowTime() { return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }); }
 
function convertTo24(timeStr) {
  if (!timeStr) return '00:00';
  const upper = timeStr.trim().toUpperCase();
  const match = upper.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!match) return '00:00';
  let hours = parseInt(match[1]);
  const minutes = match[2];
  const modifier = match[3];
  if (modifier === 'PM' && hours !== 12) hours += 12;
  if (modifier === 'AM' && hours === 12) hours = 0;
  return `${String(hours).padStart(2,'0')}:${minutes}`;
}
 
const SHIFTS = {
  'A': { start: '06:30', label: 'A Shift (6:30 AM)' },
  'B': { start: '15:15', label: 'B Shift (3:15 PM)' },
  'G': { start: '08:45', label: 'G Shift (8:45 AM)' },
  'C': { start: '23:45', label: 'C Shift (11:45 PM)' }
};
 
function checkShiftStatus(shift, checkInTime24) {
  const shiftDef = SHIFTS[shift?.toUpperCase()];
  if (!shiftDef) return 'present';
  const [sh, sm] = shiftDef.start.split(':').map(Number);
  const [ch, cm] = checkInTime24.split(':').map(Number);
  return (ch * 60 + cm) <= (sh * 60 + sm + 10) ? 'present' : 'late';
}
 
function calcTotalHours(inTime24, outTime24, date) {
  try {
    let inMs = new Date(`${date}T${inTime24}:00`).getTime();
    let outMs = new Date(`${date}T${outTime24}:00`).getTime();
    if (outMs < inMs) outMs += 24 * 60 * 60 * 1000;
    const diffMs = outMs - inMs;
    if (diffMs <= 0) return 'N/A';
    return `${Math.floor(diffMs/3600000)}h ${Math.floor((diffMs%3600000)/60000)}m`;
  } catch(e) { return 'N/A'; }
}
 
// Device fingerprint from request
function getDeviceId(req) {
  const ua = req.headers['user-agent'] || '';
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
  return crypto.createHash('md5').update(ua + ip).digest('hex');
}
 
// ── EMPLOYEE ROUTES ────────────────────────────────────────
app.get('/api/employees', async (req, res) => {
  const emps = await db.collection('employees').find({}).toArray();
  res.json(emps);
});
 
app.post('/api/employees', async (req, res) => {
  const { id, name, mobile } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'EMP ID aur naam zaroori hai' });
  const exists = await db.collection('employees').findOne({ id: id.toUpperCase() });
  if (exists) return res.status(409).json({ error: 'Yeh EMP ID pehle se exist karta hai' });
  const emp = { id: id.toUpperCase(), name, mobile: mobile || 'N/A', role: 'employee', createdAt: new Date().toISOString() };
  await db.collection('employees').insertOne(emp);
  res.json({ success: true, employee: emp });
});
 
app.delete('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  if (id === 'MW113761') return res.status(403).json({ error: 'Super admin ko delete nahi kar sakte' });
  await db.collection('employees').deleteOne({ id });
  await db.collection('attendance').deleteMany({ empId: id });
  res.json({ success: true });
});
 
// ── STATUS CHECK ───────────────────────────────────────────
app.get('/api/status/:empId', async (req, res) => {
  const empId = req.params.empId.toUpperCase();
  const deviceId = getDeviceId(req);
  const emp = await db.collection('employees').findOne({ id: empId });
  if (!emp) return res.json({ status: 'not_registered' });
 
  const record = await db.collection('attendance').findOne({ empId: emp.id, date: today() });
  if (!record) return res.json({ status: 'punch_in', employee: emp });
 
  // If already checked in — check if this device did it
  if (record.checkOut) return res.json({ status: 'already_out', employee: emp, record });
 
  // Same device check for punch out
  if (record.deviceId && record.deviceId !== deviceId) {
    return res.json({ status: 'different_device', employee: emp, record });
  }
 
  res.json({ status: 'punch_out', employee: emp, record });
});
 
// Check if device already has active session
app.get('/api/device-session', async (req, res) => {
  const deviceId = getDeviceId(req);
  const record = await db.collection('attendance').findOne({ deviceId, date: today(), checkOut: { $exists: false } });
  if (!record) return res.json({ hasSession: false });
  const emp = await db.collection('employees').findOne({ id: record.empId });
  res.json({ hasSession: true, empId: record.empId, empName: emp?.name || record.empName, record });
});
 
// ── ATTENDANCE ROUTES ──────────────────────────────────────
app.post('/api/attendance', async (req, res) => {
  const { empId, shift } = req.body;
  const deviceId = getDeviceId(req);
  if (!empId) return res.status(400).json({ error: 'EMP ID zaroori hai' });
 
  const emp = await db.collection('employees').findOne({ id: empId.toUpperCase() });
  if (!emp) return res.status(403).json({ error: 'not_listed', message: 'Aap registered nahi hain.' });
 
  // Check if this device already has an active session for someone else
  const deviceSession = await db.collection('attendance').findOne({ deviceId, date: today(), checkOut: { $exists: false } });
  if (deviceSession && deviceSession.empId !== emp.id) {
    const prevEmp = await db.collection('employees').findOne({ id: deviceSession.empId });
    return res.status(409).json({
      error: 'device_busy',
      message: `Is phone se ${prevEmp?.name || deviceSession.empId} ki attendance chal rahi hai. Pehle unka punch out karein.`
    });
  }
 
  const existing = await db.collection('attendance').findOne({ empId: emp.id, date: today() });
  if (existing) return res.status(409).json({ error: 'Aaj ki attendance pehle se mark ho chuki hai!', employee: emp });
 
  const checkInTime = nowTime();
  const checkIn24 = convertTo24(checkInTime);
  const status = shift ? checkShiftStatus(shift, checkIn24) : 'present';
  const record = {
    id: Date.now().toString(), empId: emp.id, empName: emp.name,
    date: today(), time: checkInTime, shift: shift || 'G',
    status, deviceId, markedAt: new Date().toISOString()
  };
  await db.collection('attendance').insertOne(record);
  res.json({ success: true, record, employee: emp });
});
 
app.post('/api/checkout', async (req, res) => {
  const { empId } = req.body;
  const deviceId = getDeviceId(req);
  if (!empId) return res.status(400).json({ error: 'EMP ID zaroori hai' });
 
  const emp = await db.collection('employees').findOne({ id: empId.toUpperCase() });
  if (!emp) return res.status(403).json({ error: 'not_listed' });
 
  const record = await db.collection('attendance').findOne({ empId: emp.id, date: today() });
  if (!record) return res.status(404).json({ error: 'Aaj check-in nahi mili. Pehle check-in karein.' });
  if (record.checkOut) return res.status(409).json({ error: 'already_out', message: 'Aap pehle se check-out kar chuke hain!', record, employee: emp });
 
  // Device check — only same device can checkout
  if (record.deviceId && record.deviceId !== deviceId) {
    return res.status(403).json({ error: 'wrong_device', message: 'Punch out sirf usi phone se ho sakta hai jisse punch in kiya tha!' });
  }
 
  const checkOut = nowTime();
  const totalHours = calcTotalHours(convertTo24(record.time), convertTo24(checkOut), record.date || today());
 
  await db.collection('attendance').updateOne(
    { id: record.id },
    { $set: { checkOut, checkOutAt: new Date().toISOString(), totalHours } }
  );
  const updated = await db.collection('attendance').findOne({ id: record.id });
  res.json({ success: true, record: updated, employee: emp });
});
 
// ── EDIT ATTENDANCE (PIN Protected) ───────────────────────
app.post('/api/attendance/edit', async (req, res) => {
  const { pin, attendanceId, checkIn, checkOut, shift, status } = req.body;
  if (pin !== EDIT_PIN) return res.status(403).json({ error: 'Galat PIN!' });
 
  const record = await db.collection('attendance').findOne({ id: attendanceId });
  if (!record) return res.status(404).json({ error: 'Record nahi mila' });
 
  const updates = {};
  if (checkIn) {
    updates.time = checkIn;
    if (checkOut || record.checkOut) {
      updates.totalHours = calcTotalHours(convertTo24(checkIn), convertTo24(checkOut || record.checkOut), record.date);
    }
    if (shift || record.shift) {
      updates.status = checkShiftStatus(shift || record.shift, convertTo24(checkIn));
    }
  }
  if (checkOut) {
    updates.checkOut = checkOut;
    updates.totalHours = calcTotalHours(convertTo24(checkIn || record.time), convertTo24(checkOut), record.date);
  }
  if (shift) { updates.shift = shift; updates.status = checkShiftStatus(shift, convertTo24(checkIn || record.time)); }
  if (status) updates.status = status;
  updates.editedAt = new Date().toISOString();
 
  await db.collection('attendance').updateOne({ id: attendanceId }, { $set: updates });
  const updated = await db.collection('attendance').findOne({ id: attendanceId });
  res.json({ success: true, record: updated });
});
 
// Verify edit PIN
app.post('/api/verify-pin', async (req, res) => {
  const { pin } = req.body;
  if (pin === EDIT_PIN) return res.json({ success: true });
  res.status(403).json({ error: 'Galat PIN' });
});
 
app.delete('/api/attendance/employee/:id', async (req, res) => {
  const { id } = req.params;
  const { date } = req.query;
  if (date) await db.collection('attendance').deleteMany({ empId: id, date });
  else await db.collection('attendance').deleteMany({ empId: id });
  res.json({ success: true });
});
 
app.get('/api/attendance/today', async (req, res) => {
  const emps = await db.collection('employees').find({}).toArray();
  const todayAtt = await db.collection('attendance').find({ date: today() }).toArray();
  const result = emps.map(e => {
    const rec = todayAtt.find(a => a.empId === e.id);
    return { ...e, date: today(), time: rec ? rec.time : '—', checkOut: rec?.checkOut || '—', totalHours: rec?.totalHours || '—', shift: rec?.shift || '—', status: rec ? rec.status : 'absent', attended: !!rec };
  });
  res.json(result);
});
 
app.get('/api/attendance', async (req, res) => {
  const { date, empId } = req.query;
  const filter = {};
  if (date) filter.date = date;
  if (empId) filter.empId = empId;
  const result = await db.collection('attendance').find(filter).sort({ markedAt: -1 }).toArray();
  res.json(result);
});
 
app.get('/api/attendance/employee/:id', async (req, res) => {
  const emp = await db.collection('employees').findOne({ id: req.params.id.toUpperCase() });
  if (!emp) return res.status(404).json({ error: 'Employee nahi mila' });
  const empAtt = await db.collection('attendance').find({ empId: emp.id }).sort({ markedAt: -1 }).toArray();
  const present = empAtt.filter(a => a.status === 'present').length;
  const late = empAtt.filter(a => a.status === 'late').length;
  res.json({ employee: emp, attendance: empAtt, stats: { present, late, total: empAtt.length } });
});
 
// Monthly attendance stats
app.get('/api/attendance/monthly', async (req, res) => {
  const { month, year } = req.query;
  const m = month || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(5,7);
  const y = year || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0,4);
  const start = `${y}-${m}-01`;
  const end = `${y}-${m}-31`;
  const att = await db.collection('attendance').find({ date: { $gte: start, $lte: end } }).toArray();
  res.json(att);
});
 
// ── ADMIN LOGIN ────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { empId, password } = req.body;
  const emp = await db.collection('employees').findOne({ id: empId?.toUpperCase(), role: 'admin', mobile: password });
  if (!emp) return res.status(401).json({ error: 'Galat ID ya password' });
  res.json({ success: true, admin: emp });
});
 
// ── EXCEL EXPORT ───────────────────────────────────────────
app.get('/api/export/today', async (req, res) => {
  const emps = await db.collection('employees').find({}).toArray();
  const todayStr = today();
  const att = await db.collection('attendance').find({ date: todayStr }).toArray();
  const rows = [['EMP ID', 'Name', 'Mobile', 'Shift', 'Check-in', 'Check-out', 'Total Hours', 'Status']];
  emps.forEach(e => {
    const rec = att.find(a => a.empId === e.id);
    rows.push([e.id, e.name, e.mobile, rec?.shift || '—', rec?.time || '—', rec?.checkOut || '—', rec?.totalHours || '—', rec ? rec.status : 'Absent']);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:12},{wch:22},{wch:14},{wch:8},{wch:12},{wch:12},{wch:12},{wch:10}];
  XLSX.utils.book_append_sheet(wb, ws, 'Aaj ki Attendance');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Maswer_${todayStr}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
 
app.get('/api/export/monthly', async (req, res) => {
  const { month, year } = req.query;
  const m = month || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(5,7);
  const y = year || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0,4);
  const start = `${y}-${m}-01`;
  const end = `${y}-${m}-31`;
  const att = await db.collection('attendance').find({ date: { $gte: start, $lte: end } }).sort({ date: 1, markedAt: 1 }).toArray();
  const rows = [['EMP ID', 'Name', 'Date', 'Shift', 'Check-in', 'Check-out', 'Total Hours', 'Status']];
  att.forEach(a => rows.push([a.empId, a.empName, a.date, a.shift||'—', a.time, a.checkOut||'—', a.totalHours||'—', a.status]));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:12},{wch:22},{wch:12},{wch:8},{wch:12},{wch:12},{wch:12},{wch:10}];
  XLSX.utils.book_append_sheet(wb, ws, `${y}-${m} Attendance`);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Maswer_${y}-${m}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
 
app.get('/api/export/all', async (req, res) => {
  const att = await db.collection('attendance').find({}).sort({ date: -1, markedAt: -1 }).toArray();
  const rows = [['EMP ID', 'Name', 'Date', 'Shift', 'Check-in', 'Check-out', 'Total Hours', 'Status']];
  att.forEach(a => rows.push([a.empId, a.empName, a.date, a.shift||'—', a.time, a.checkOut||'—', a.totalHours||'—', a.status]));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:12},{wch:22},{wch:12},{wch:8},{wch:12},{wch:12},{wch:12},{wch:10}];
  XLSX.utils.book_append_sheet(wb, ws, 'Full Attendance');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Maswer_Full.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
 
// ── LOCATION ROUTES ───────────────────────────────────────
app.get('/api/location', async (req, res) => {
  const loc = await db.collection('settings').findOne({ key: 'location' });
  res.json(loc ? loc.value : {});
});
 
app.post('/api/location', async (req, res) => {
  const { lat, lng, radius, name } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'Lat/Lng zaroori hai' });
  const value = { lat: parseFloat(lat), lng: parseFloat(lng), radius: parseInt(radius)||100, name: name||'Office', updatedAt: new Date().toISOString() };
  await db.collection('settings').updateOne({ key: 'location' }, { $set: { key: 'location', value } }, { upsert: true });
  res.json({ success: true, location: value });
});
 
app.delete('/api/location', async (req, res) => {
  await db.collection('settings').deleteOne({ key: 'location' });
  res.json({ success: true });
});
 
// ── QR CODE ────────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  const host = process.env.APP_URL || `http://localhost:${PORT}`;
  const url = `${host}/scan`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, { width: 300, margin: 2, color: { dark: '#1E2D4E', light: '#FFFFFF' } });
    res.json({ qr: qrDataUrl, url });
  } catch(err) { res.status(500).json({ error: 'QR generate nahi hua' }); }
});
 
// ── PAGE ROUTES ────────────────────────────────────────────
const PUB = (process.env.PUBLIC_DIR || (fs.existsSync(path.join(__dirname,'public')) ? path.join(__dirname,'public') : __dirname));
app.get('/', (req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.get('/scan', (req, res) => res.sendFile(path.join(PUB, 'scan.html')));
app.get('/attendance', (req, res) => res.sendFile(path.join(PUB, 'attendance.html')));
 
// ── START ──────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ Maswer Attend chal raha hai → http://localhost:${PORT}`);
    console.log(`📱 Scan page: http://localhost:${PORT}/scan`);
    console.log(`🔑 Login: MW113761 / 8146162102\n`);
  });
}).catch(err => { console.error('MongoDB connect nahi hua:', err.message); process.exit(1); });
