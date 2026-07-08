const ExcelJS = require('exceljs');
(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(process.argv[2]);
  wb.eachSheet((sheet) => {
    console.log('HAROK:', sheet.name, '| riadkov:', sheet.rowCount);
    for (let r = 1; r <= 5 && r <= sheet.rowCount; r++) {
      const vals = [];
      sheet.getRow(r).eachCell({ includeEmpty: true }, (c, i) => { if (i <= 12) vals.push(String(c.text).slice(0, 34)); });
      console.log('r' + r, JSON.stringify(vals));
    }
  });
})().catch((e) => console.error('ERR', e.message));
