// Interview tips for job seekers: what to bring, what to say and what to ask,
// for interviews in general and for each popular role (the same roles as the
// /jobs/role pages). Plain words, written for a first job as much as a tenth.
// Every page also carries the safety rule: nobody should ask for money.

// Steps for any interview, in the order they happen.
const GENERAL = [
  {
    id: 'before', heading: 'The day before',
    points: [
      'Read the job listing again: the pay, the shift, the place and what they need. Write down anything you want to ask.',
      'Find out how to reach the place and how long it takes. Plan to arrive 15 minutes early.',
      'Keep your phone charged and your number on. Employers often call from a new number on the day.',
      'Get your documents ready in one folder (see "What to bring").',
    ],
  },
  {
    id: 'bring', heading: 'What to bring',
    points: [
      'A photo ID: Aadhaar card, voter ID, PAN card or driving licence. Carry the original and a photocopy.',
      'Two or three printed copies of your resume, if you have one. If you don\'t, you can make one free on the resume builder.',
      'Copies of your marksheets or certificates, and experience or relieving letters from earlier jobs.',
      'Two passport-size photos, a pen and a little cash for travel.',
    ],
  },
  {
    id: 'on-the-day', heading: 'On the day',
    points: [
      'Wear clean, simple clothes. A plain shirt and trousers or a kurta is fine for most jobs.',
      'Greet them, sit when asked and keep your phone on silent.',
      'Listen to the whole question before you answer. Short, honest answers are better than long ones.',
      'If you don\'t know something, say so and say how you would find out. Nobody expects you to know everything.',
      'Talk about real things you have done: a target you met, a customer you helped, a machine you fixed.',
    ],
  },
  {
    id: 'questions', heading: 'Questions most interviews ask',
    qa: [
      ['Tell me about yourself.', 'Say your name, where you live, your education, your last job (or that you are a fresher) and why you want this job. Keep it under a minute.'],
      ['Why do you want this job?', 'Say something true about the job: the work, the place, the shift or learning something new. Don\'t talk only about money.'],
      ['Why did you leave your last job?', 'Give a short, polite reason (better pay, closer to home, the work ended). Don\'t speak badly about your old employer.'],
      ['What salary do you expect?', 'Know the pay on the listing and what the role usually pays. Say a range and that you are open to talk.'],
      ['When can you join?', 'Give a real date. If you have a notice period at your current job, say how long it is.'],
    ],
  },
  {
    id: 'ask', heading: 'Questions to ask them',
    points: [
      'What will I do on a normal day, and who will I report to?',
      'What is the in-hand pay each month, and are PF or ESI cut from it?',
      'What are the working hours, the weekly off and the overtime pay?',
      'Is there a joining date, and what happens after this interview?',
    ],
  },
  {
    id: 'phone', heading: 'Phone and video interviews',
    points: [
      'Sit somewhere quiet with good network. For a video call, face a window or a light.',
      'Keep the job listing and your resume in front of you.',
      'Say your name when you pick up, and speak a little slower than usual.',
    ],
  },
  {
    id: 'walk-in', heading: 'Walk-in interviews',
    points: [
      'Go early in the walk-in time. Late in the day the openings may already be filled.',
      'Carry everything from "What to bring". There may be a short test or form to fill on the spot.',
      'Take the name and number of the person you met, so you can follow up.',
    ],
  },
  {
    id: 'after', heading: 'After the interview',
    points: [
      'Thank them before you leave, and ask when you will hear back.',
      'If you haven\'t heard by that day, call or message once, politely.',
      'Read the offer letter fully before you sign: pay, hours, place and notice period.',
    ],
  },
];

// The safety rule shown on every tips page.
const SAFETY = [
  'Never pay anyone to get an interview or a job: no registration fee, no training fee, no uniform deposit.',
  'Never hand over your original documents to keep. Showing them is fine; they can keep photocopies.',
  'Don\'t share OTPs, bank PINs or passwords. No real employer needs them.',
  'Go to interviews at an office or a public place in the daytime, and tell someone where you are going.',
];

// Per-role tips, keyed like the /jobs/role pages (ROLE_PAGES keys in server.js).
const ROLES = {
  delivery: {
    intro: 'Delivery interviews are short and practical. They want to know you can ride safely, find addresses and be on time.',
    bring: ['Driving licence for a two-wheeler', 'Vehicle RC and insurance, if you will use your own bike', 'Aadhaar and PAN card', 'A smartphone that runs the delivery app'],
    questions: [
      ['Do you know the roads in this area?', 'Name the areas you know well. Say you use Google Maps for new addresses.'],
      ['How many deliveries can you do in a day?', 'Give a real number from past work, or say you will learn the route quickly and aim to meet their target.'],
      ['What will you do if a customer is not at home?', 'Call the customer, wait a few minutes, and follow the company\'s steps in the app. Never leave a parcel without permission.'],
      ['Can you work in rain and on weekends?', 'Be honest about the days and shifts you can do.'],
    ],
    show: ['Safe riding and a clean licence', 'Using maps and a delivery app', 'Being polite to customers', 'Being on time'],
    ask: ['Is pay per order, per day or a fixed salary, and how are incentives worked out?', 'Who pays for petrol and phone data?', 'Is there accident insurance?'],
  },
  driver: {
    intro: 'Driver interviews usually include a short driving test. They check your licence, your driving and how well you know the city.',
    bring: ['Driving licence for the right vehicle (LMV, HMV or commercial badge)', 'Aadhaar card', 'Police verification, if you have one', 'Experience letter from earlier driving jobs'],
    questions: [
      ['How many years have you been driving?', 'Say the years and the vehicles you have driven: car, tempo, truck or bus.'],
      ['Have you had any accidents or challans?', 'Answer truthfully. If there was one, say what you learned.'],
      ['Do you know the city routes?', 'Name main routes and areas you know. Say you use maps for new places.'],
      ['Can you do night duty or outstation trips?', 'Say clearly what you can and cannot do.'],
    ],
    show: ['Calm, safe driving in the test', 'Basic vehicle checks: tyres, oil, brakes', 'Keeping the vehicle clean', 'Being on time and polite to passengers'],
    ask: ['What are the duty hours, and is overtime or night allowance paid?', 'Who pays for fuel, tolls and parking?', 'Is food or stay given on outstation trips?'],
  },
  telecaller: {
    intro: 'Telecaller interviews test how you speak. Many include a short mock call, so speak clearly and smile while you talk.',
    bring: ['Resume', 'Aadhaar and PAN card', 'Marksheets (10th, 12th or degree)', 'Earlier salary slips, if you have them'],
    questions: [
      ['Sell me this pen (or this product).', 'Ask what the person needs first, then say how the product helps them. Keep it simple and friendly.'],
      ['What will you do if a customer gets angry?', 'Stay calm, listen, say sorry for the trouble and offer to help or pass it to the right person.'],
      ['How many calls can you make in a day?', 'Give a number from past work, or say you are ready to meet their target.'],
      ['Which languages can you speak?', 'Name every language you speak well. Many teams need Hindi or a local language more than English.'],
    ],
    show: ['Clear, polite speaking', 'Patience with difficult callers', 'Typing notes into a computer or CRM', 'Handling "no" without giving up'],
    ask: ['Is it inbound or outbound calling?', 'How are targets and incentives set?', 'What are the shift timings and the weekly off?'],
  },
  sales: {
    intro: 'Sales interviews look for confidence and results. Come ready with numbers from your past work, even small ones.',
    bring: ['Resume', 'Aadhaar and PAN card', 'Proof of past targets or incentives, if you have it', 'Two-wheeler licence, if it is a field sales job'],
    questions: [
      ['What was your last target, and did you meet it?', 'Give the target and what you achieved. If you missed it, say why and what you changed.'],
      ['How will you find new customers?', 'Talk about visiting shops, calling leads, asking happy customers for references and following up.'],
      ['Sell me this product.', 'Ask a few questions about what they need, then explain the benefit, not just the features.'],
      ['How do you handle rejection?', 'Say you take it calmly, learn from it and move to the next customer.'],
    ],
    show: ['Confidence and a friendly manner', 'Following up with customers', 'Knowing your numbers', 'Knowing the local market'],
    ask: ['How is the incentive worked out, and when is it paid?', 'Is travel allowance given for field visits?', 'What is the target in the first three months?'],
  },
  dataEntry: {
    intro: 'Data entry interviews often have a typing test. Practise typing for a few days before, and check your work for mistakes.',
    bring: ['Resume', 'Aadhaar and PAN card', 'Marksheets and any computer course certificate (MS-CIT, DCA, Tally)', 'A pen for the written test'],
    questions: [
      ['What is your typing speed?', 'Know your words per minute from a free online test. Accuracy matters as much as speed.'],
      ['Which software do you know?', 'Name what you have used: MS Excel, Word, Google Sheets, Tally or a company system.'],
      ['How do you check your work for mistakes?', 'Say you re-read entries, compare with the source and use simple checks like totals.'],
      ['Can you work long hours at a computer?', 'Be honest, and say you take short breaks to stay accurate.'],
    ],
    show: ['Fast and accurate typing', 'Basic Excel: sorting, filters and simple formulas', 'Care with numbers and spelling', 'Keeping data private'],
    ask: ['Is the work from the office or from home?', 'Is pay fixed or per entry?', 'Will I need my own laptop or internet?'],
  },
  warehouse: {
    intro: 'Warehouse interviews check that you can do physical work safely, follow instructions and work in shifts.',
    bring: ['Aadhaar card', 'Bank passbook (for salary and PF)', 'Two passport-size photos', 'Forklift licence or certificate, if you have one'],
    questions: [
      ['Have you worked in a warehouse before?', 'Say what you did: picking, packing, loading, sorting or stock counts.'],
      ['Can you lift heavy boxes and stand for long hours?', 'Answer honestly. Say if you have used trolleys or pallet jacks.'],
      ['Can you work night shifts or rotating shifts?', 'Say which shifts suit you.'],
      ['What is a scanner or a pick list?', 'If you have used them, say so. If not, say you are ready to learn.'],
    ],
    show: ['Following safety rules', 'Counting and checking stock carefully', 'Working as a team', 'Being regular and on time'],
    ask: ['Are PF and ESI given?', 'Is there transport or food at night shifts?', 'Is overtime paid, and at what rate?'],
  },
  security: {
    intro: 'Security guard interviews check your fitness, alertness and how you would handle problems on duty.',
    bring: ['Aadhaar card', 'Police verification certificate, if you have one', 'PSARA or security training certificate, if you have one', 'Ex-servicemen papers, if you served'],
    questions: [
      ['What would you do if a stranger tries to enter without a pass?', 'Stop them politely, ask for ID and the purpose, check with the person they are visiting and note it in the register.'],
      ['Have you done night duty before?', 'Say where and for how long, and how you stay alert.'],
      ['What will you do in a fire or emergency?', 'Raise the alarm, call the supervisor and emergency number, and help people leave by the safe exits.'],
      ['Can you keep the visitor register?', 'Say you can write entries neatly with time, name and purpose.'],
    ],
    show: ['Alertness and discipline', 'Polite but firm manner', 'Keeping registers neatly', 'Basic fire safety'],
    ask: ['How many hours is each shift, and is there a weekly off?', 'Is the uniform free? (It should not need a deposit.)', 'Are PF and ESI given?'],
  },
  electrician: {
    intro: 'Electrician interviews often include a practical test. They want to see that you work safely and know your tools.',
    bring: ['ITI certificate (Electrician) or diploma', 'Wireman licence, if you have one', 'Aadhaar card', 'Experience letters and photos of past work'],
    questions: [
      ['What is the first thing you do before working on a line?', 'Switch off the supply, check with a tester that it is dead, and lock or tag it so nobody turns it on.'],
      ['What is the difference between an MCB and an RCCB?', 'An MCB trips on overload or short circuit; an RCCB trips on earth leakage to protect people from shock.'],
      ['Have you done house wiring, panel work or maintenance?', 'Say exactly what you have done and in what kind of building.'],
      ['How do you find a fault?', 'Explain checking step by step with a tester or multimeter, from the supply to the load.'],
    ],
    show: ['Safety first, every time', 'Reading simple wiring diagrams', 'Using a multimeter and tester', 'Neat, finished work'],
    ask: ['Are tools and safety gear given?', 'Is the work on one site or travelling?', 'Is overtime or call-out paid?'],
  },
  cook: {
    intro: 'Cook interviews often include a cooking trial. Clean as you go and taste before you serve.',
    bring: ['Aadhaar card', 'Experience letters from earlier kitchens', 'Hotel management or food safety certificate, if you have one', 'Medical fitness certificate, if asked'],
    questions: [
      ['Which dishes and cuisines can you cook?', 'Name what you cook best: North Indian, South Indian, Chinese, tandoor, continental or home-style.'],
      ['How many people have you cooked for at once?', 'Give a real number, like a 50-cover restaurant or a 200-person canteen.'],
      ['How do you keep the kitchen clean and food safe?', 'Talk about washing hands, separate boards for raw and cooked food, covering food and storing it at the right temperature.'],
      ['Can you plan the day\'s cooking and order supplies?', 'Say if you have done it, or that you can learn.'],
    ],
    show: ['Taste and speed in the trial', 'Hygiene and a clean workspace', 'Using less waste', 'Working calmly at rush hour'],
    ask: ['Are food and stay given?', 'What are the hours and the weekly off?', 'How many people will I cook for each day?'],
  },
  accountant: {
    intro: 'Accountant interviews test your basics: entries, GST, TDS and Tally or other software. Be ready for a short practical test.',
    bring: ['Resume', 'B.Com, M.Com or CA/CMA papers and marksheets', 'Tally or GST course certificate, if you have one', 'Experience letters and salary slips'],
    questions: [
      ['What is the difference between a debit and a credit?', 'Debit is the left side of an entry and credit the right. Use the golden rules or an example, like a cash sale.'],
      ['How do you file GST returns?', 'Say which returns you have filed (GSTR-1, GSTR-3B) and how you match purchase invoices.'],
      ['What is TDS?', 'Tax deducted at source: tax cut when paying salary, rent or contractors, deposited with the government and shown in returns.'],
      ['Which software have you used?', 'Name it: Tally Prime, Busy, Zoho Books, SAP or Excel.'],
    ],
    show: ['Correct entries and bank reconciliation', 'GST and TDS basics', 'Tally and Excel', 'Meeting month-end deadlines'],
    ask: ['Which software do you use?', 'Will I handle GST filing, payroll or only entries?', 'Who will I report to?'],
  },
  nurse: {
    intro: 'Nurse interviews check your registration, clinical knowledge and how you care for patients, and may include a short skills check.',
    bring: ['Nursing council registration certificate', 'GNM, B.Sc or ANM certificates and marksheets', 'Experience letters', 'Aadhaar card and photos'],
    questions: [
      ['Which wards have you worked in?', 'Name them: ICU, general ward, OT, emergency, pediatrics, and for how long.'],
      ['How do you check a patient\'s vital signs?', 'Explain temperature, pulse, breathing, blood pressure and oxygen, and when you report them.'],
      ['What do you do before giving a medicine?', 'Check the right patient, medicine, dose, route and time, and note any allergies.'],
      ['How do you handle a worried family member?', 'Listen, explain kindly what you can, and bring the doctor in for medical questions.'],
    ],
    show: ['Patient care and kindness', 'Infection control and hand hygiene', 'Clear notes and handovers', 'Staying calm in emergencies'],
    ask: ['How many patients will I care for in a shift?', 'Are night shifts rotating?', 'Is accommodation or transport given?'],
  },
  developer: {
    intro: 'Developer interviews usually have a coding round and a talk about your projects. Explain your thinking out loud.',
    bring: ['Resume with links to your GitHub or projects', 'Degree marksheets', 'A laptop, if they ask you to', 'Experience letters and last salary slips'],
    questions: [
      ['Tell me about a project you built.', 'Say what it does, what you built yourself, the tools you used and one problem you solved.'],
      ['Solve this coding problem.', 'Ask questions first, talk through a simple solution, then improve it. Test with a small example.'],
      ['What happens when you open a website?', 'Explain DNS, the request to the server, the response and the browser drawing the page.'],
      ['How do you use Git?', 'Talk about branches, commits, pull requests and fixing merge conflicts.'],
    ],
    show: ['Clear thinking on problems', 'Your own projects', 'Reading and writing clean code', 'Working with a team'],
    ask: ['What will I work on first?', 'How does the team review code?', 'Is it work from office, hybrid or remote?'],
  },
};

const forRole = (key) => ROLES[key] || null;
const sectionById = (id) => GENERAL.find((s) => s.id === id) || null;

module.exports = { GENERAL, SAFETY, ROLES, forRole, sectionById };
