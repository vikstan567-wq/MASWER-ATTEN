const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const XLSX = require('xlsx');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(process.env.PUBLIC_DIR || path.join(__dirname, 'public')));

// ── Simple JSON file database ──────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EMP_FILE = path.join(DATA_DIR, 'employees.json');
const ATT_FILE = path.join(DATA_DIR, 'attendance.json');
const LOC_FILE = path.join(DATA_DIR, 'location.json');

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Seed default admin if no employees exist
function initData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EMP_FILE)) {
    writeJSON(EMP_FILE, [
      { id: 'MW113761', name: 'Vivek Singh', mobile: '8146162102', role: 'admin', createdAt: new Date().toISOString() }
    ]);
  }
  if (!fs.existsSync(ATT_FILE)) writeJSON(ATT_FILE, []);
}
initData();

// ── Helpers ────────────────────────────────────────────────
function today() {
  return new Date().toISOString().split('T')[0];
}
function nowTime() {
  return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function isLate() {
  const h = new Date().getHours();
  return h >= 9;
}

// ── EMPLOYEE ROUTES ────────────────────────────────────────

// Get all employees
app.get('/api/employees', (req, res) => {
  const emps = readJSON(EMP_FILE, []);
  res.json(emps);
});

// Add employee
app.post('/api/employees', (req, res) => {
  const { id, name, mobile } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'EMP ID aur naam zaroori hai' });
  const emps = readJSON(EMP_FILE, []);
  if (emps.find(e => e.id === id.toUpperCase())) {
    return res.status(409).json({ error: 'Yeh EMP ID pehle se exist karta hai' });
  }
  const emp = { id: id.toUpperCase(), name, mobile: mobile || 'N/A', role: 'employee', createdAt: new Date().toISOString() };
  emps.push(emp);
  writeJSON(EMP_FILE, emps);
  res.json({ success: true, employee: emp });
});

// Delete employee
app.delete('/api/employees/:id', (req, res) => {
  const { id } = req.params;
  if (id === 'MW113761') return res.status(403).json({ error: 'Super admin ko delete nahi kar sakte' });
  let emps = readJSON(EMP_FILE, []);
  emps = emps.filter(e => e.id !== id);
  writeJSON(EMP_FILE, emps);
  // Also remove attendance
  let att = readJSON(ATT_FILE, []);
  att = att.filter(a => a.empId !== id);
  writeJSON(ATT_FILE, att);
  res.json({ success: true });
});

// ── ATTENDANCE ROUTES ──────────────────────────────────────

// Mark attendance (QR scan submit)
app.post('/api/attendance', (req, res) => {
  const { empId, name } = req.body;
  if (!empId) return res.status(400).json({ error: 'EMP ID zaroori hai' });

  const emps = readJSON(EMP_FILE, []);
  const emp = emps.find(e => e.id === empId.toUpperCase());

  // NOT REGISTERED - BLOCK karo
  if (!emp) {
    return res.status(403).json({ 
      error: 'not_listed',
      message: 'You are not listed in this system. Please contact your admin.'
    });
  }

  const att = readJSON(ATT_FILE, []);
  const todayStr = today();

  // Already marked?
  if (att.find(a => a.empId === emp.id && a.date === todayStr)) {
    return res.status(409).json({ error: 'Aaj ki attendance pehle se mark ho chuki hai!', employee: emp });
  }

  const record = {
    id: Date.now().toString(),
    empId: emp.id,
    empName: emp.name,
    date: todayStr,
    time: nowTime(),
    status: isLate() ? 'late' : 'present',
    markedAt: new Date().toISOString()
  };
  att.push(record);
  writeJSON(ATT_FILE, att);
  res.json({ success: true, record, employee: emp });
});

// ── STATUS CHECK (Smart Punch In/Out) ─────────────────────
// Returns: not_registered | punch_in | punch_out | already_out
app.get('/api/status/:empId', (req, res) => {
  const empId = req.params.empId.toUpperCase();
  const emps = readJSON(EMP_FILE, []);
  const emp = emps.find(e => e.id === empId);
  if (!emp) return res.json({ status: 'not_registered' });

  const att = readJSON(ATT_FILE, []);
  const todayStr = today();
  const record = att.find(a => a.empId === emp.id && a.date === todayStr);

  if (!record) {
    // No check-in today → show Punch In
    return res.json({ status: 'punch_in', employee: emp });
  }
  if (record.checkOut) {
    // Already checked out → next scan = Punch In (new day handled by date check above)
    return res.json({ status: 'already_out', employee: emp, record });
  }
  // Checked in but not out → show Punch Out
  res.json({ status: 'punch_out', employee: emp, record });
});

// Check Out
app.post('/api/checkout', (req, res) => {
  const { empId } = req.body;
  if (!empId) return res.status(400).json({ error: 'EMP ID zaroori hai' });

  const emps = readJSON(EMP_FILE, []);
  const emp = emps.find(e => e.id === empId.toUpperCase());
  if (!emp) return res.status(403).json({ error: 'not_listed', message: 'Aap registered nahi hain.' });

  const att = readJSON(ATT_FILE, []);
  const todayStr = today();
  const record = att.find(a => a.empId === emp.id && a.date === todayStr);

  if (!record) return res.status(404).json({ error: 'Aaj ki attendance nahi mili. Pehle check-in karein.' });
  if (record.checkOut) return res.status(409).json({ error: 'already_out', message: 'Aap pehle se check-out kar chuke hain!', record, employee: emp });

  record.checkOut = nowTime();
  record.checkOutAt = new Date().toISOString();

  // Calculate hours
  try {
    const inTime = new Date(`${todayStr}T${convertTo24(record.time)}`);
    const outTime = new Date(`${todayStr}T${convertTo24(record.checkOut)}`);
    const diffMs = outTime - inTime;
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    record.totalHours = `${hours}h ${mins}m`;
  } catch(e) { record.totalHours = 'N/A'; }

  writeJSON(ATT_FILE, att);
  res.json({ success: true, record, employee: emp });
});

function convertTo24(timeStr) {
  if (!timeStr) return '00:00:00';
  const [time, modifier] = timeStr.split(' ');
  let [hours, minutes] = time.split(':');
  if (modifier === 'PM' && hours !== '12') hours = parseInt(hours) + 12;
  if (modifier === 'AM' && hours === '12') hours = '00';
  return `${String(hours).padStart(2,'0')}:${minutes}:00`;
}

// Delete attendance by employee
app.delete('/api/attendance/employee/:id', (req, res) => {
  const { id } = req.params;
  const { date } = req.query;
  let att = readJSON(ATT_FILE, []);
  if (date) {
    att = att.filter(a => !(a.empId === id && a.date === date));
  } else {
    att = att.filter(a => a.empId !== id);
  }
  writeJSON(ATT_FILE, att);
  res.json({ success: true });
});

// Get today's attendance
app.get('/api/attendance/today', (req, res) => {
  const att = readJSON(ATT_FILE, []);
  const emps = readJSON(EMP_FILE, []);
  const todayStr = today();
  const todayAtt = att.filter(a => a.date === todayStr);

  // Merge absent employees
  const result = emps.map(e => {
    const rec = todayAtt.find(a => a.empId === e.id);
    return {
      ...e,
      date: todayStr,
      time: rec ? rec.time : '—',
      status: rec ? rec.status : 'absent',
      attended: !!rec
    };
  });
  res.json(result);
});

// Get all attendance (with optional filters)
app.get('/api/attendance', (req, res) => {
  const att = readJSON(ATT_FILE, []);
  const { date, empId } = req.query;
  let result = att;
  if (date) result = result.filter(a => a.date === date);
  if (empId) result = result.filter(a => a.empId === empId);
  result.sort((a, b) => new Date(b.markedAt) - new Date(a.markedAt));
  res.json(result);
});

// Get attendance for one employee
app.get('/api/attendance/employee/:id', (req, res) => {
  const att = readJSON(ATT_FILE, []);
  const emps = readJSON(EMP_FILE, []);
  const emp = emps.find(e => e.id === req.params.id.toUpperCase());
  if (!emp) return res.status(404).json({ error: 'Employee nahi mila' });
  const empAtt = att.filter(a => a.empId === emp.id).sort((a, b) => new Date(b.markedAt) - new Date(a.markedAt));
  const present = empAtt.filter(a => a.status !== 'absent').length;
  res.json({ employee: emp, attendance: empAtt, stats: { present, total: empAtt.length } });
});

// ── ADMIN LOGIN ────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { empId, password } = req.body;
  const emps = readJSON(EMP_FILE, []);
  const emp = emps.find(e => e.id === empId?.toUpperCase() && e.role === 'admin' && e.mobile === password);
  if (!emp) return res.status(401).json({ error: 'Galat ID ya password' });
  res.json({ success: true, admin: emp });
});

// ── EXCEL EXPORT ───────────────────────────────────────────
app.get('/api/export/today', (req, res) => {
  const att = readJSON(ATT_FILE, []);
  const emps = readJSON(EMP_FILE, []);
  const todayStr = today();
  const rows = [['EMP ID', 'Name', 'Mobile', 'Check-in Time', 'Status']];
  emps.forEach(e => {
    const rec = att.find(a => a.empId === e.id && a.date === todayStr);
    rows.push([e.id, e.name, e.mobile, rec ? rec.time : '—', rec ? rec.status : 'Absent']);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Aaj ki Attendance');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Maswer_Attend_${todayStr}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('/api/export/all', (req, res) => {
  const att = readJSON(ATT_FILE, []);
  const rows = [['EMP ID', 'Name', 'Date', 'Check-in Time', 'Status']];
  att.sort((a, b) => new Date(b.markedAt) - new Date(a.markedAt))
     .forEach(a => rows.push([a.empId, a.empName, a.date, a.time, a.status]));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 14 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Full Attendance');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Maswer_Attend_Full.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── LOCATION ROUTES ───────────────────────────────────────
app.get('/api/location', (req, res) => {
  try {
    if (!fs.existsSync(LOC_FILE)) return res.json({});
    res.json(JSON.parse(fs.readFileSync(LOC_FILE, 'utf8')));
  } catch { res.json({}); }
});

app.post('/api/location', (req, res) => {
  const { lat, lng, radius, name } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'Lat/Lng zaroori hai' });
  const loc = {
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    radius: parseInt(radius) || 100,
    name: name || 'Office',
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(LOC_FILE, JSON.stringify(loc, null, 2));
  res.json({ success: true, location: loc });
});

app.delete('/api/location', (req, res) => {
  if (fs.existsSync(LOC_FILE)) fs.unlinkSync(LOC_FILE);
  res.json({ success: true });
});

// ── QR CODE ────────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  const ngrokUrl = "https://spouse-clothes-sublet.ngrok-free.dev";
  const url = `${ngrokUrl}/scan`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 300, margin: 2,
      color: { dark: '#1E2D4E', light: '#FFFFFF' }
    });
    res.json({ qr: qrDataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'QR generate nahi hua' });
  }
});

// ── PAGE ROUTES ────────────────────────────────────────────
const PUB = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
app.get('/', (req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.get('/scan', (req, res) => res.sendFile(path.join(PUB, 'scan.html')));
app.get('/attendance', (req, res) => res.sendFile(path.join(PUB, 'attendance.html')));

app.listen(PORT, () => {
  console.log('\n✅ Maswer Attend server chal raha hai!');
  console.log(`\n🌐 Admin panel:  http://localhost:${PORT}`);
  console.log(`📱 Scan page:    http://localhost:${PORT}/scan`);
  console.log('\nLogin: ID = MW113761  |  Password = 8146162102\n');
});
