'use strict';
const { PDF } = require('./pdf');
const xlsx = require('./xlsx');
const { fmt2 } = require('./scoring');

const longDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: process.env.TZ || 'Africa/Lagos' }) : '';

function resultSheetPDF(sheet) {
  const doc = new PDF().page();
  const L = 48, R = doc.W - 48, Wd = R - L;
  let y = 40;

  // Header
  if (sheet.school.logo && sheet.school.logoW && sheet.school.logoH) {
    const m = /^data:image\/jpeg;base64,(.+)$/.exec(sheet.school.logo);
    if (m) {
      const scale = 64 / Math.max(sheet.school.logoW, sheet.school.logoH);
      doc.jpeg(Buffer.from(m[1], 'base64'), L, y, sheet.school.logoW * scale, sheet.school.logoH * scale, sheet.school.logoW, sheet.school.logoH);
    }
  }
  doc.text(L, y + 4, sheet.school.name.toUpperCase(), { size: 17, bold: true, align: 'center', width: Wd, color: '#1d3b2a' });
  doc.text(L, y + 28, `${(sheet.assessmentName || '').toUpperCase()} — STUDENT RESULT SHEET`.replace(/^ — /, ''), { size: 11.5, bold: true, align: 'center', width: Wd, color: '#444444' });
  doc.text(L, y + 46, `${sheet.session} Academic Session  •  ${sheet.term}`, { size: 10, align: 'center', width: Wd, color: '#444444' });
  y += 80;
  doc.line(L, y, R, y, { color: '#1d3b2a', width: 1.4 });
  y += 14;

  // Student details
  const det = [
    ['Student name', sheet.student.name], ['Admission number', sheet.student.admNo],
    ['Section', sheet.student.level], ['Class', sheet.student.className],
    ['Session', sheet.session], ['Term', sheet.term],
  ];
  for (let i = 0; i < det.length; i += 2) {
    for (let j = 0; j < 2; j++) {
      const [k, v] = det[i + j];
      const x = L + j * (Wd / 2);
      doc.text(x, y, k.toUpperCase(), { size: 7.5, bold: true, color: '#777777' });
      doc.text(x, y + 10, String(v), { size: 11, bold: j === 0 && i === 0 });
    }
    y += 30;
  }
  y += 4;

  // Subject table
  const cols = [{ t: 'Subject', w: 0.34 }, { t: 'Score (out of 40)', w: 0.26 }, { t: 'Grade', w: 0.12 }, { t: 'Remark', w: 0.28 }];
  const rowH = 22;
  doc.rect(L, y, Wd, rowH, { fill: '#1d3b2a' });
  let x = L;
  for (const c of cols) { doc.text(x + 8, y + 6.5, c.t, { size: 9.5, bold: true, color: '#ffffff' }); x += c.w * Wd; }
  y += rowH;
  sheet.subjects.forEach((s, i) => {
    if (i % 2 === 1) doc.rect(L, y, Wd, rowH, { fill: '#f1f5f2' });
    const cells = s.score != null
      ? [s.subject, `Score: ${fmt2(s.score)} / 40`, s.grade, s.remark]
      : [s.subject, s.status === 'pending_review' ? 'Result pending review' : 'Marking in progress', '', ''];
    x = L;
    cells.forEach((c, ci) => { doc.text(x + 8, y + 6.5, String(c ?? ''), { size: 10, bold: ci === 1 && s.score != null }); x += cols[ci].w * Wd; });
    y += rowH;
  });
  doc.rect(L, y - rowH * (sheet.subjects.length + 1), Wd, rowH * (sheet.subjects.length + 1), { stroke: '#b8c4bb' });
  y += 14;

  // Summary
  const subjWord = sheet.counted === 1 ? 'subject' : 'subjects';
  const summary = [
    ['Total', sheet.counted ? `${fmt2(sheet.total)} / ${sheet.totalMax}  (40 × ${sheet.counted} ${subjWord})` : '—'],
    ['Average', sheet.average != null ? `${fmt2(sheet.average)} / 40` : '—'],
    ['Overall grade', sheet.overallGrade ? `${sheet.overallGrade} — ${sheet.overallRemark}` : '—'],
  ];
  if (sheet.positionsEnabled) summary.push(['Position', sheet.position ? `${sheet.position} of ${sheet.classSize}` : 'Available when all class results are complete']);
  doc.rect(L, y, Wd, 20 * summary.length + 12, { fill: '#f7f9f7', stroke: '#b8c4bb' });
  y += 8;
  for (const [k, v] of summary) {
    doc.text(L + 12, y + 3, k, { size: 10, bold: true, color: '#333333' });
    doc.text(L + 130, y + 3, v, { size: 10.5, bold: k === 'Total' || k === 'Average' });
    y += 20;
  }
  y += 18;
  if (!sheet.allComplete) {
    doc.text(L, y, 'Some subjects are still pending; the total and average include completed subjects only.', { size: 9, color: '#9a5b00' });
    y += 18;
  }

  // Comments
  for (const [k, v] of [['Class teacher’s comment', sheet.teacherComment], ['Principal’s comment', sheet.principalComment]]) {
    doc.text(L, y, k, { size: 10, bold: true });
    y += 15;
    const boxTop = y;
    if (v) y = doc.para(L + 8, y + 6, v, Wd - 16, { size: 10 }) + 6;
    else y += 30;
    y = Math.max(y, boxTop + 34);
    doc.rect(L, boxTop, Wd, y - boxTop, { stroke: '#b8c4bb' });
    y += 14;
  }

  y += 6;
  doc.text(L, y, `Publication date: ${sheet.publishedAt ? longDate(sheet.publishedAt) : 'Not yet published'}`, { size: 10 });
  doc.line(R - 170, y + 10, R, y + 10, { color: '#555555' });
  doc.text(R - 170, y + 14, 'Signature / Stamp', { size: 8, align: 'center', width: 170, color: '#666666' });
  doc.text(L, doc.H - 40, `Generated ${longDate(new Date().toISOString())}`, { size: 7.5, color: '#999999' });
  return doc.toBuffer();
}

function broadsheetTable(bs) {
  const header = ['S/N', 'Student name', 'Admission number', 'Class', ...bs.subjects.map((s) => `${s} (Score / 40)`), 'Total', 'Average (/ 40)', 'Grade', 'Remark'];
  if (bs.positionsOn) header.push('Position');
  const rows = bs.rows.map((r, i) => {
    const row = [i + 1, r.name, r.admNo, r.className,
      ...bs.subjects.map((s) => (typeof r.scores[s] === 'number' ? { v: r.scores[s], outOf: 40 } : (r.scores[s] || ''))),
      r.counted ? { v: r.total, outOf: r.totalMax } : '',
      r.average != null ? { v: r.average, outOf: 40 } : '',
      r.grade, r.remark];
    if (bs.positionsOn) row.push(r.position);
    return row;
  });
  return { header, rows };
}

function csvCell(c) {
  let s = c && typeof c === 'object' ? `${fmt2(c.v)} / ${c.outOf}` : String(c ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s;          // avoid spreadsheet formula injection from names
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function broadsheetCSV(bs, title) {
  const { header, rows } = broadsheetTable(bs);
  const lines = [[title], header, ...rows].map((r) => r.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function broadsheetXLSX(bs, title) {
  const { header, rows } = broadsheetTable(bs);
  const safe = rows.map((r) => r.map((c) => (typeof c === 'string' && /^[=+\-@]/.test(c) ? "'" + c : c)));
  return xlsx.build('Broadsheet', [[title], header, ...safe], { titleRows: 2, widths: [6, 28, 18, 9, ...bs.subjects.map(() => 22), 16, 15, 8, 12, 10] });
}

module.exports = { resultSheetPDF, broadsheetCSV, broadsheetXLSX, longDate };
