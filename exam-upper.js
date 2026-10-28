'use strict';
// JSS2 & JSS3 — Upper section. Source: "JSS2 and 3 Upper section.pdf".
const { mcq } = require('./helpers');
const P = 'U';

const letterCriteria = (contentDescriptor) => [
  { id: 'content', name: 'Content', marks: 3, descriptor: 'Relevant ideas, adequate details and coverage of all parts of the task. ' + contentDescriptor },
  { id: 'organisation', name: 'Organisation', marks: 2, descriptor: 'Appropriate informal letter format (writer’s address, date, informal salutation, introduction, body paragraphs, conclusion, suitable closing and first name), logical paragraphs and clear sequence.' },
  { id: 'expression', name: 'Expression', marks: 3, descriptor: 'Clear sentences, suitable vocabulary, correct grammar and a friendly tone.' },
  { id: 'mechanics', name: 'Mechanical accuracy', marks: 2, descriptor: 'Correct spelling, punctuation and capitalisation.' },
];
const partial = 'Award partial marks (in steps of ½) according to the quality of the response. Avoid penalising the same error under more than one criterion.';

module.exports = {
  code: 'ENG-UPPER',
  subject: 'English Language',
  level: 'Upper',
  classes: ['JSS2', 'JSS3'],
  title: 'English Language — JSS2 & JSS3',
  durationMinutes: 90,
  interactive: false,
  instructions: [
    'Answer all questions in Section A. Choose the correct option from A–D.',
    'Answer BOTH letters in Section B. Write 150–200 words for each letter.',
  ],
  passages: {},
  groups: [
    { id: 'all', title: 'Whole test', rawMax: 50, weight: 40 },
  ],
  sections: [
    {
      id: 'A', title: 'Section A: Grammar', group: 'all',
      instructions: 'Choose the correct option from A–D. Each question carries 1 mark.',
      questions: [
        mcq(P, 1, 'Amina is my friend. _____ is very kind.', ['He', 'She', 'It', 'They'], 'B'),
        mcq(P, 2, 'The teacher asked Musa and _____ to clean the board.', ['I', 'mine', 'me', 'myself'], 'C'),
        mcq(P, 3, 'This bag belongs to me. It is _____.', ['mine', 'my', 'me', 'myself'], 'A'),
        mcq(P, 4, 'The children prepared the meal by _____.', ['ourselves', 'himself', 'themselves', 'itself'], 'C'),
        mcq(P, 5, '_____ of the two boys is your brother?', ['Whose', 'Which', 'Whom', 'What'], 'B'),
        mcq(P, 6, 'The girl _____ won the competition is my sister.', ['whose', 'whom', 'which', 'who'], 'D'),
        mcq(P, 7, 'Neither John nor Peter brought _____ notebook.', ['his', 'their', 'our', 'her'], 'A'),
        mcq(P, 8, 'In “They invited us to the party,” which word is an object pronoun?', ['They', 'invited', 'us', 'party'], 'C'),
        mcq(P, 9, 'Which word is an adjective in “The clever girl solved the puzzle”?', ['girl', 'solved', 'clever', 'puzzle'], 'C'),
        mcq(P, 10, 'This road is _____ than the other one.', ['narrow', 'narrower', 'narrowest', 'most narrowest'], 'B'),
        mcq(P, 11, 'Of the three pupils, Ada is the _____.', ['tall', 'taller', 'tallest', 'more tall'], 'C'),
        mcq(P, 12, 'We bought _____ oranges at the market.', ['sweet', 'sweetly', 'sweetness', 'sweeten'], 'A'),
        mcq(P, 13, 'Which of the following is a possessive adjective?', ['mine', 'yours', 'theirs', 'our'], 'D'),
        mcq(P, 14, 'In “Those shoes are expensive,” “Those” is a _____ adjective.', ['demonstrative', 'descriptive', 'possessive', 'interrogative'], 'A'),
        mcq(P, 15, 'Choose the correct order of adjectives.', ['a leather beautiful black bag', 'a beautiful black leather bag', 'a black leather beautiful bag', 'a leather black beautiful bag'], 'B'),
        mcq(P, 16, 'The pupils listened _____ to the instructions.', ['careful', 'care', 'carefully', 'caring'], 'C'),
        mcq(P, 17, 'Which word is an adverb in “The baby slept peacefully”?', ['The', 'baby', 'slept', 'peacefully'], 'D'),
        mcq(P, 18, 'In “We shall travel tomorrow,” “tomorrow” is an adverb of _____.', ['manner', 'time', 'place', 'degree'], 'B'),
        mcq(P, 19, 'In “She always arrives early,” which word shows frequency?', ['She', 'always', 'arrives', 'early'], 'B'),
        mcq(P, 20, 'The soup is _____ hot to eat.', ['too', 'many', 'much', 'enough'], 'A'),
        mcq(P, 21, 'Which sentence contains an adverb of place?', ['He spoke politely.', 'We arrived yesterday.', 'The children are playing outside.', 'She often visits us.'], 'C'),
        mcq(P, 22, 'Choose the correct sentence.', ['The athlete ran quick.', 'The athlete ran quickly.', 'The athlete ran quickness.', 'The athlete ran quickerly.'], 'B'),
        mcq(P, 23, 'Every morning, Tunde _____ to school.', ['walk', 'walks', 'walking', 'have walked'], 'B'),
        mcq(P, 24, 'Yesterday, we _____ a football match.', ['watch', 'watches', 'watched', 'watching'], 'C'),
        mcq(P, 25, 'The girls _____ singing now.', ['is', 'am', 'are', 'was'], 'C'),
        mcq(P, 26, 'She has _____ her homework.', ['do', 'did', 'does', 'done'], 'D'),
        mcq(P, 27, 'Neither the teacher nor the pupils _____ absent today.', ['is', 'are', 'was', 'has'], 'B'),
        mcq(P, 28, 'Which word is the main verb in “The boys have finished their work”?', ['boys', 'have', 'finished', 'their'], 'C'),
        mcq(P, 29, 'If I study hard, I _____ pass the examination.', ['will', 'would', 'was', 'had'], 'A'),
        mcq(P, 30, 'Which sentence is in the past continuous tense?', ['She reads a novel.', 'She has read a novel.', 'She was reading a novel.', 'She will read a novel.'], 'C'),
      ],
    },
    {
      id: 'B', title: 'Section B: Informal Letter Writing', group: 'all',
      instructions: 'Answer BOTH questions. Each letter carries 10 marks. Write 150–200 words for each letter.',
      questions: [
        {
          id: P + '31', num: 31, label: 'Letter 1', type: 'essay', marks: 10, minWords: 150, maxWords: 200,
          prompt: 'Write a letter to your friend in another school, describing your school’s recent cultural day. Mention at least three activities that took place and explain what you enjoyed most.',
          scheme: {
            status: 'approved',
            task: [
              'Describes the school’s cultural day.',
              'Mentions at least three activities that took place.',
              'Explains what the writer enjoyed most.',
              'Informal letter format: writer’s address, date, informal salutation, introduction, body paragraphs, conclusion, suitable closing and first name.',
              'Length: 150–200 words.',
            ],
            criteria: letterCriteria('For full content marks, the letter should describe the school’s cultural day, mention at least three activities and explain what the writer enjoyed most.'),
            partialCredit: partial,
          },
        },
        {
          id: P + '32', num: 32, label: 'Letter 2', type: 'essay', marks: 10, minWords: 150, maxWords: 200,
          prompt: 'Write a letter to your cousin, telling him or her how you spent your last holiday. Describe two interesting experiences and explain why you would like to spend your next holiday together.',
          scheme: {
            status: 'approved',
            task: [
              'Explains how the writer spent the last holiday.',
              'Describes two interesting experiences.',
              'Explains why the writer wants to spend the next holiday with the cousin.',
              'Informal letter format: writer’s address, date, informal salutation, introduction, body paragraphs, conclusion, suitable closing and first name.',
              'Length: 150–200 words.',
            ],
            criteria: letterCriteria('For full content marks, the letter should explain how the writer spent the holiday, describe two interesting experiences and explain why the writer wants to spend the next holiday with the cousin.'),
            partialCredit: partial,
          },
        },
      ],
    },
  ],
};
