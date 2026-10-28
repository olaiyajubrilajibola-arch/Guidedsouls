'use strict';
// SSS1–SSS3 — Advanced section. Source: "Advanced class.pdf".
// Grammar (60 short written answers, raw 30 → 20), informal letter (10), opinion essay (10) = 40.
const P = 'S';

const PASSAGE_VERBS = ['organised', 'worked', 'attracted', 'arranged', 'welcomed', 'displayed', 'praised',
  'believed', 'impressed', 'applauded', 'smiled', 'spoke', 'requested'];

function nameQ(num, prompt, context, accept, subtypeOptional, expected) {
  const rule = { kind: 'category', accept };
  if (subtypeOptional) rule.subtypeAccept = subtypeOptional;
  return {
    id: P + num, num, type: 'short', marks: 0.5, prompt, context,
    scheme: {
      criteria: [{ id: 'name', marks: 0.5, desc: 'Correct grammatical name', expected, rule }],
      partialCredit: 'All-or-nothing (½ mark). A wrongly stated subtype, or two different names, earns no mark.',
    },
  };
}

function funcQ(num, prompt, context, roles, targets, expected, others) {
  const rule = { kind: 'function', roles, targets };
  if (others) rule.others = others.filter((w) => !targets.includes(w));
  return {
    id: P + num, num, type: 'short', marks: 0.5, prompt, context,
    scheme: {
      criteria: [{ id: 'function', marks: 0.5, desc: 'Correct grammatical function, naming the word or expression concerned', expected, rule }],
      partialCredit: 'All-or-nothing (½ mark). The function and the word or expression concerned must both be identified (instruction 3).',
    },
  };
}

function clauseQ(num, sentence, text) {
  return {
    id: P + num, num, type: 'short', marks: 0.5, prompt: 'Write out the subordinate clause.', context: sentence,
    scheme: {
      criteria: [{ id: 'clause', marks: 0.5, desc: 'Whole subordinate clause copied, including its introductory word', expected: text, rule: { kind: 'clause', text } }],
      partialCredit: 'All-or-nothing (½ mark). Minor spelling slips are ignored; missing the introductory word or adding words outside the clause earns no mark.',
    },
  };
}

function nameTypeQ(num, sentence, accept, subtypes, expected) {
  return {
    id: P + num, num, type: 'short', marks: 0.5, prompt: 'State its grammatical name and type.', context: sentence,
    scheme: {
      criteria: [
        { id: 'name', marks: 0.25, desc: 'Correct clause name', expected: expected.name, rule: { kind: 'category', accept } },
        { id: 'type', marks: 0.25, desc: 'Correct subtype', expected: expected.type, rule: { kind: 'subtype', requires: accept, accept: subtypes } },
      ],
      partialCredit: '¼ mark for the correct clause name and ¼ mark for the correct subtype. The subtype mark needs a correct clause name.',
    },
  };
}

const passageParagraphs = [
  'Our school organised an exhibition last Friday. The learners worked <u>carefully</u> <b>[A]</b>. The <u>colourful</u> <b>[B]</b> posters attracted visitors. Amina arranged <u>the books</u> <b>[C]</b>. <u>She</u> <b>[D]</b> welcomed the guests.',
  'The learners <u>who belonged to the science club</u> <b>[E]</b> displayed a model bridge. Our principal, <u>who had supported the project</u> <b>[F]</b>, praised their effort. The visitors believed <u>that the bridge was strong</u> <b>[G]</b>. <u>What the learners had achieved</u> <b>[H]</b> impressed everyone.',
  '<u>When the demonstration ended</u> <b>[I]</b>, the guests applauded. The learners smiled <u>because their experiment had succeeded</u> <b>[J]</b>. They spoke clearly <u>so that everyone could hear them</u> <b>[K]</b>. The demonstration was so interesting <u>that the visitors requested another session</u> <b>[L]</b>.',
];

const exprs = [
  // label, expression, sentence, name accept, optional subtypes, name key, roles, targets, function key
  ['A', 'carefully', 'The learners worked carefully.', ['adverb'], ['manner'], 'Adverb; accept adverb of manner.', ['modify'], ['worked'], 'Modifies the verb “worked”, showing how the learners worked.'],
  ['B', 'colourful', 'The colourful posters attracted visitors.', ['adjective'], null, 'Adjective.', ['modify'], ['posters'], 'Qualifies/modifies the noun “posters”.'],
  ['C', 'the books', 'Amina arranged the books.', ['noun phrase'], null, 'Noun phrase.', ['object'], ['arranged'], 'Functions as the direct object of “arranged”.'],
  ['D', 'She', 'She welcomed the guests.', ['personal pronoun', 'pronoun', 'subject pronoun'], null, 'Personal pronoun.', ['subject'], ['welcomed'], 'Functions as the subject of “welcomed”.'],
  ['E', 'who belonged to the science club', 'The learners who belonged to the science club displayed a model bridge.', ['relative clause'], ['defining'], 'Relative/adjectival clause. Accept defining relative clause.', ['modify'], ['learners'], 'Qualifies/modifies “learners”, identifying which learners displayed the bridge.'],
  ['F', 'who had supported the project', 'Our principal, who had supported the project, praised their effort.', ['relative clause'], ['non-defining'], 'Relative/adjectival clause. Accept non-defining relative clause.', ['modify'], ['principal'], 'Qualifies/modifies “principal”, adding information about the principal.'],
  ['G', 'that the bridge was strong', 'The visitors believed that the bridge was strong.', ['noun clause'], null, 'Noun clause.', ['object'], ['believed'], 'Functions as the direct object of “believed”.'],
  ['H', 'What the learners had achieved', 'What the learners had achieved impressed everyone.', ['noun clause'], null, 'Noun clause.', ['subject'], ['impressed'], 'Functions as the subject of “impressed”.'],
  ['I', 'When the demonstration ended', 'When the demonstration ended, the guests applauded.', ['adverbial clause'], ['time'], 'Adverbial clause; accept adverbial clause of time.', ['modify'], ['applauded'], 'Modifies “applauded”, stating when the guests applauded.'],
  ['J', 'because their experiment had succeeded', 'The learners smiled because their experiment had succeeded.', ['adverbial clause'], ['reason'], 'Adverbial clause; accept adverbial clause of reason/cause.', ['modify'], ['smiled'], 'Modifies “smiled”, stating why the learners smiled.'],
  ['K', 'so that everyone could hear them', 'They spoke clearly so that everyone could hear them.', ['adverbial clause'], ['purpose'], 'Adverbial clause; accept adverbial clause of purpose.', ['modify'], ['spoke'], 'Modifies “spoke”, stating the purpose of speaking clearly.'],
  ['L', 'that the visitors requested another session', 'The demonstration was so interesting that the visitors requested another session.', ['adverbial clause'], ['result'], 'Adverbial clause; accept adverbial clause of result/consequence.', ['result', 'modify'], ['interesting'], 'Expresses the result of the demonstration being so interesting; relates to “was so interesting”.'],
];

const sectionAQuestions = [];
exprs.forEach((e, i) => {
  const [label, expr, sentence, accept, subs, nameKey, roles, targets, funcKey] = e;
  const n = i * 2 + 1;
  sectionAQuestions.push(nameQ(n, `Expression ${label}: “${expr}” — What is its grammatical name?`, sentence, accept, subs, nameKey));
  sectionAQuestions.push(funcQ(n + 1, `Expression ${label}: “${expr}” — What is its grammatical function?`, sentence, roles, targets, funcKey, PASSAGE_VERBS));
});

const S = [
  'That the team won the competition delighted the coach.',
  'The teacher explained that the examination would begin at nine.',
  'The truth is that somebody left the gate open.',
  'We talked about what the speaker had said.',
  'The learner who returned the missing purse received a reward.',
  'Our head teacher, who joined the school last year, addressed the parents.',
  'The bicycle that Musa repaired belongs to his sister.',
  'Mrs Bello, whose daughter won the scholarship, thanked the school.',
  'Before the lesson began, the monitor cleaned the board.',
  'The match was postponed because the field was flooded.',
  'If you revise your notes, you will understand the topic better.',
  'Although the task was difficult, the learners completed it.',
];
const ctx = (i) => `Sentence ${i + 1}: ${S[i]}`;
const fnPrompt = 'State its grammatical function.';
const namePrompt = 'State its grammatical name.';
const REL = ['relative clause'];
const ADV = ['adverbial clause'];

const sectionBQuestions = [
  clauseQ(25, ctx(0), 'That the team won the competition'),
  nameQ(26, namePrompt, ctx(0), ['noun clause'], null, 'Noun clause'),
  funcQ(27, fnPrompt, ctx(0), ['subject'], ['delighted'], 'Subject of “delighted”.'),

  clauseQ(28, ctx(1), 'that the examination would begin at nine'),
  nameQ(29, namePrompt, ctx(1), ['noun clause'], null, 'Noun clause'),
  funcQ(30, fnPrompt, ctx(1), ['object'], ['explained'], 'Direct object of “explained”.'),

  clauseQ(31, ctx(2), 'that somebody left the gate open'),
  nameQ(32, namePrompt, ctx(2), ['noun clause'], null, 'Noun clause'),
  funcQ(33, fnPrompt, ctx(2), ['complement'], ['is', 'truth'], 'Subject complement after “is”; completes the meaning of “The truth”.'),

  clauseQ(34, ctx(3), 'what the speaker had said'),
  nameQ(35, namePrompt, ctx(3), ['noun clause'], null, 'Noun clause'),
  funcQ(36, fnPrompt, ctx(3), ['prep_object', 'object', 'complement'], ['about', 'preposition'], 'Object/complement of the preposition “about”.'),

  clauseQ(37, ctx(4), 'who returned the missing purse'),
  nameTypeQ(38, ctx(4), REL, ['defining'], { name: 'Relative/adjectival clause', type: 'Defining' }),
  funcQ(39, fnPrompt, ctx(4), ['modify'], ['learner'], 'Qualifies “learner”, identifying which learner received a reward.'),

  clauseQ(40, ctx(5), 'who joined the school last year'),
  nameTypeQ(41, ctx(5), REL, ['non-defining'], { name: 'Relative/adjectival clause', type: 'Non-defining' }),
  funcQ(42, fnPrompt, ctx(5), ['modify'], ['head teacher', 'teacher'], 'Qualifies “head teacher”, adding information about the head teacher.'),

  clauseQ(43, ctx(6), 'that Musa repaired'),
  nameTypeQ(44, ctx(6), REL, ['defining'], { name: 'Relative/adjectival clause', type: 'Defining' }),
  funcQ(45, fnPrompt, ctx(6), ['modify'], ['bicycle'], 'Qualifies “bicycle”, identifying which bicycle belongs to Musa’s sister.'),

  clauseQ(46, ctx(7), 'whose daughter won the scholarship'),
  nameTypeQ(47, ctx(7), REL, ['non-defining'], { name: 'Relative/adjectival clause', type: 'Non-defining' }),
  funcQ(48, fnPrompt, ctx(7), ['modify'], ['mrs bello', 'bello'], 'Qualifies “Mrs Bello”, adding information about her.'),

  clauseQ(49, ctx(8), 'Before the lesson began'),
  nameTypeQ(50, ctx(8), ADV, ['time'], { name: 'Adverbial clause', type: 'Time' }),
  funcQ(51, fnPrompt, ctx(8), ['modify'], ['cleaned'], 'Modifies “cleaned”, stating when the monitor cleaned the board.'),

  clauseQ(52, ctx(9), 'because the field was flooded'),
  nameTypeQ(53, ctx(9), ADV, ['reason'], { name: 'Adverbial clause', type: 'Reason/cause' }),
  funcQ(54, fnPrompt, ctx(9), ['modify'], ['postponed'], 'Modifies “was postponed”, explaining why the match was postponed.'),

  clauseQ(55, ctx(10), 'If you revise your notes'),
  nameTypeQ(56, ctx(10), ADV, ['condition'], { name: 'Adverbial clause', type: 'Condition' }),
  funcQ(57, fnPrompt, ctx(10), ['modify'], ['understand'], 'Modifies “will understand”, stating the condition for understanding the topic better.'),

  clauseQ(58, ctx(11), 'Although the task was difficult'),
  nameTypeQ(59, ctx(11), ADV, ['concession'], { name: 'Adverbial clause', type: 'Concession' }),
  funcQ(60, fnPrompt, ctx(11), ['modify'], ['completed'], 'Modifies “completed”, expressing a difficulty despite which the learners completed the task.'),
];

// The source says the letter and essay "retain their existing marking guides", but those guides are not in the
// document. At the school's request these standard criteria (the same structure as the JSS2/3 letter guide) are
// used automatically, so the test is available at once. Teachers can still edit them on the teacher page.
const writingCriteria = (contentDescriptor, formatDescriptor) => [
  { id: 'content', name: 'Content', marks: 3, descriptor: contentDescriptor },
  { id: 'organisation', name: 'Organisation', marks: 2, descriptor: formatDescriptor },
  { id: 'expression', name: 'Expression', marks: 3, descriptor: 'Clear sentences, suitable vocabulary, correct grammar and an appropriate tone.' },
  { id: 'mechanics', name: 'Mechanical accuracy', marks: 2, descriptor: 'Correct spelling, punctuation and capitalisation.' },
];

module.exports = {
  code: 'ENG-ADVANCED',
  subject: 'English Language',
  level: 'Advanced',
  classes: ['SSS1', 'SSS2', 'SSS3'],
  title: 'English Language — SSS1 to SSS3',
  durationMinutes: 90,
  interactive: false,
  instructions: [
    'Answer all questions.',
    'Read each sentence carefully before identifying grammatical names and functions.',
    'When stating a function, identify the particular word or expression concerned. For example: qualifies the noun “teacher”.',
    'In Part B, copy the whole subordinate clause, including its introductory word.',
    '“Relative clause” and “adjectival clause” are acceptable alternative names.',
    'Write between 250 and 300 words for the letter and for the essay.',
  ],
  passages: {
    exhibition: { title: 'A Successful Exhibition', paragraphs: passageParagraphs, html: true },
  },
  groups: [
    { id: 'grammar', title: 'Grammar', rawMax: 30, weight: 20 },
    { id: 'letter', title: 'Informal letter', rawMax: 10, weight: 10 },
    { id: 'essay', title: 'Opinion essay', rawMax: 10, weight: 10 },
  ],
  sections: [
    {
      id: 'A', title: 'Grammar Part A: Passage', group: 'grammar', passage: 'exhibition',
      instructions: 'Answer the questions about the twelve underlined expressions labelled A–L. Each question carries ½ mark.',
      questions: sectionAQuestions,
    },
    {
      id: 'B', title: 'Grammar Part B: Clause Identification, Types and Functions', group: 'grammar',
      instructions: 'Each sentence contains one subordinate clause. For a noun clause, state its name (its role belongs in your function answer). For a relative clause, state whether it is defining or non-defining. For an adverbial clause, state its type, such as time, reason, condition or concession. Each question carries ½ mark.',
      questions: sectionBQuestions,
    },
    {
      id: 'C', title: 'Writing: Informal Letter', group: 'letter',
      instructions: 'Write between 250 and 300 words. Pay attention to organisation, grammar, spelling and punctuation.',
      questions: [{
        id: P + '61', num: 61, label: 'Letter', type: 'essay', marks: 10, minWords: 250, maxWords: 300,
        prompt: 'Your friend in another school has written to tell you that they intend to stop schooling because they believe education is no longer useful. Write a letter to your friend explaining three reasons why education remains important and suggesting two practical ways to overcome the difficulties they face at school.',
        scheme: {
          status: 'approved', source: 'standard criteria (no separate guide supplied)',
          task: [
            'Explains three reasons why education remains important.',
            'Suggests two practical ways to overcome the friend’s difficulties at school.',
            'Informal letter format: writer’s address, date, informal salutation, introduction, body paragraphs, conclusion, suitable closing and first name.',
            'Length: 250–300 words.',
          ],
          criteria: writingCriteria(
            'Relevant ideas with adequate detail: three clear reasons why education remains important and two practical suggestions for overcoming difficulties at school.',
            'Appropriate informal letter format, logical paragraphs and a clear sequence.'),
          partialCredit: 'Award partial marks (in steps of ½) according to the quality of the response. Avoid penalising the same error under more than one criterion.',
        },
      }],
    },
    {
      id: 'D', title: 'Writing: Opinion Essay', group: 'essay',
      instructions: 'Write between 250 and 300 words. Pay attention to organisation, grammar, spelling and punctuation.',
      questions: [{
        id: P + '62', num: 62, label: 'Essay', type: 'essay', marks: 10, minWords: 250, maxWords: 300,
        prompt: 'Write an essay on the topic: “In Your Opinion, Does Social Media Have a Positive or Negative Influence on Secondary School Students?” Clearly state your opinion and explain three reasons for your view, using relevant examples. Conclude by suggesting how students can use social media responsibly.',
        scheme: {
          status: 'approved', source: 'standard criteria (no separate guide supplied)',
          task: [
            'Clearly states an opinion (positive or negative influence).',
            'Explains three reasons for the view, with relevant examples.',
            'Concludes by suggesting how students can use social media responsibly.',
            'Length: 250–300 words.',
          ],
          criteria: writingCriteria(
            'A clearly stated opinion, three well-explained reasons supported by relevant examples, and a conclusion suggesting responsible use of social media. Either opinion is acceptable if well supported.',
            'Clear introduction, body paragraphs and conclusion; logical sequence of ideas.'),
          partialCredit: 'Award partial marks (in steps of ½) according to the quality of the response. Avoid penalising the same error under more than one criterion.',
        },
      }],
    },
  ],
};
