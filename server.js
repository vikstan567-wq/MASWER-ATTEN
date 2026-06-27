const express = require('express');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');
 
const app = express();
const PORT = process.env.PORT || 3000;
 
app.use(cors());
app.use(express.json());
const fs = require('fs');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
app.use(express.static(fs.existsSync(PUBLIC_DIR) ? PUBLIC_DIR : __dirname));
 
// ── MongoDB Connection ─────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
let db;
 
async function connectDB() {
  if (!MONGO_URI) {
    console.error('❌ MONGO_URI environment variable set nahi hai!');
    process.exit(1);
  }
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('maswer_attend');
  console.log('✅ MongoDB connected!');
 
  // Seed default admin if no employees
  const emps = db.collection('employees');
  const count = await emps.countDocuments();
  if (count === 0) {
    await emps.insertOne({
      id: 'MW113761', name: 'Vivek Singh', mobile: '8146162102',
      role: 'admin', createdAt: new Date().toISOString()
    });
    console.log('✅ Default admin seeded.');
  }
}
 
// ── Helpers ────────────────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }
function nowTime() {
  return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function isLate() { return new Date().getHours() >= 9; }
function convertTo24(timeStr) {
  if (!timeStr) return '00:00:00';
  const [time, modifier] = timeStr.split(' ');
  let [hours, minutes] = time.split(':');
  if (modifier === 'PM' && hours !== '12') hours = parseInt(hours) + 12;
  if (modifier === 'AM' && hours === '12') hours = '00';
  return `${String(hours).padStart(2,'0')}:${minutes}:00`;
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
 
// ── STATUS CHECK (Smart Punch In/Out) ─────────────────────
app.get('/api/status/:empId', async (req, res) => {
  const empId = req.params.empId.toUpperCase();
  const emp = await db.collection('employees').findOne({ id: empId });
  if (!emp) return res.json({ status: 'not_registered' });
  const record = await db.collection('attendance').findOne({ empId: emp.id, date: today() });
  if (!record) return res.json({ status: 'punch_in', employee: emp });
  if (record.checkOut) return res.json({ status: 'already_out', employee: emp, record });
  res.json({ status: 'punch_out', employee: emp, record });
});
 
// ── ATTENDANCE ROUTES ──────────────────────────────────────
app.post('/api/attendance', async (req, res) => {
  const { empId } = req.body;
  if (!empId) return res.status(400).json({ error: 'EMP ID zaroori hai' });
  const emp = await db.collection('employees').findOne({ id: empId.toUpperCase() });
  if (!emp) return res.status(403).json({ error: 'not_listed', message: 'Aap registered nahi hain.' });
  const existing = await db.collection('attendance').findOne({ empId: emp.id, date: today() });
  if (existing) return res.status(409).json({ error: 'Aaj ki attendance pehle se mark ho chuki hai!', employee: emp });
  const record = {
    id: Date.now().toString(), empId: emp.id, empName: emp.name,
    date: today(), time: nowTime(), status: isLate() ? 'late' : 'present',
    markedAt: new Date().toISOString()
  };
  await db.collection('attendance').insertOne(record);
  res.json({ success: true, record, employee: emp });
});
 
app.post('/api/checkout', async (req, res) => {
  const { empId } = req.body;
  if (!empId) return res.status(400).json({ error: 'EMP ID zaroori hai' });
  const emp = await db.collection('employees').findOne({ id: empId.toUpperCase() });
  if (!emp) return res.status(403).json({ error: 'not_listed' });
  const record = await db.collection('attendance').findOne({ empId: emp.id, date: today() });
  if (!record) return res.status(404).json({ error: 'Aaj check-in nahi mili. Pehle check-in karein.' });
  if (record.checkOut) return res.status(409).json({ error: 'already_out', message: 'Aap pehle se check-out kar chuke hain!', record, employee: emp });
 
  const checkOut = nowTime();
  let totalHours = 'N/A';
  try {
    const inTime = new Date(`${today()}T${convertTo24(record.time)}`);
    const outTime = new Date(`${today()}T${convertTo24(checkOut)}`);
    const diffMs = outTime - inTime;
    totalHours = `${Math.floor(diffMs/3600000)}h ${Math.floor((diffMs%3600000)/60000)}m`;
  } catch(e) {}
 
  await db.collection('attendance').updateOne(
    { id: record.id },
    { $set: { checkOut, checkOutAt: new Date().toISOString(), totalHours } }
  );
  const updated = await db.collection('attendance').findOne({ id: record.id });
  res.json({ success: true, record: updated, employee: emp });
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
    return { ...e, date: today(), time: rec ? rec.time : '—', status: rec ? rec.status : 'absent', attended: !!rec };
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
  res.json({ employee: emp, attendance: empAtt, stats: { present: empAtt.length, total: empAtt.length } });
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
  const rows = [['EMP ID', 'Name', 'Mobile', 'Check-in', 'Check-out', 'Total Hours', 'Status']];
  emps.forEach(e => {
    const rec = att.find(a => a.empId === e.id);
    rows.push([e.id, e.name, e.mobile, rec?.time || '—', rec?.checkOut || '—', rec?.totalHours || '—', rec ? rec.status : 'Absent']);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch:12},{ wch:22},{ wch:14},{ wch:12},{ wch:12},{ wch:12},{ wch:10}];
  XLSX.utils.book_append_sheet(wb, ws, 'Aaj ki Attendance');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Maswer_${todayStr}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
 
app.get('/api/export/all', async (req, res) => {
  const att = await db.collection('attendance').find({}).sort({ markedAt: -1 }).toArray();
  const rows = [['EMP ID', 'Name', 'Date', 'Check-in', 'Check-out', 'Total Hours', 'Status']];
  att.forEach(a => rows.push([a.empId, a.empName, a.date, a.time, a.checkOut||'—', a.totalHours||'—', a.status]));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch:12},{ wch:22},{ wch:12},{ wch:12},{ wch:12},{ wch:12},{ wch:10}];
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
}).catch(err => {
  console.error('MongoDB connect nahi hua:', err.message);
  process.exit(1);
});
