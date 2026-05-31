const xlsx = require('xlsx');
const wb = xlsx.readFile('rates_bar.xlsx');
const sheet = wb.Sheets[wb.SheetNames[0]];
const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

const excelRows = data.slice(3).filter(r => r[1] && typeof r[1] === 'string').map(r => ({
  name: r[1].trim(),
  bar: r[4], conf1: r[5], conf2: r[6], pdr: r[7], parcel: r[10]
}));

const missing = [
  'Finger Chips','Paneer Manchurian','Paneer Mejestick','Pepper Mushroom',
  'Egg Roast','Chicken Fry / Roast','Chicken Wings','Chicken Mejestick',
  'Golden Fried Prawns','Tawa Fish','Tandoori Chicken','Tangdi Kebab',
  'Egg Kheema Curry','Cashew Chicken Curry','Chicken Fry Biryani',
  'Moghalai Chicken Biryani','Mutton Fry Biryani','Mutton Kheema Biryani',
  'Sambhar Rice','Cashewnut Fried Rice','Shezwan Chicken Fried Rice',
  'Shezwan Chicken Noodles'
];

for (const m of missing) {
  const ml = m.toLowerCase();
  const mTokens = ml.split(/[\s/]+/).filter(t => t.length > 1);
  
  const candidates = excelRows.filter(e => {
    const el = e.name.toLowerCase();
    const eTokens = el.split(/[\s/]+/).filter(t => t.length > 1);
    let overlap = 0;
    for (const t of mTokens) {
      if (eTokens.some(et => et.includes(t) || t.includes(et))) overlap++;
    }
    return overlap >= Math.max(1, mTokens.length * 0.5);
  }).slice(0, 3);
  
  if (candidates.length > 0) {
    console.log(m + ' →');
    candidates.forEach(c => console.log('  ' + c.name + ' (bar:' + c.bar + ' pdr:' + c.pdr + ')'));
  } else {
    console.log(m + ' → NO MATCH');
  }
}
