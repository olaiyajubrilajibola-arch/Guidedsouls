'use strict';
// Deterministic marking for tightly constrained grammar answers (names, types, functions, clause copying).
// Each rule returns { awarded: boolean, certain: boolean, evidence: string[], reason: string, feedback: string }.
// "certain: false" means the rules could not apply the scheme reliably; the caller then uses AI-assisted
// marking (if configured) or sends the answer to examiner review. It never silently becomes a zero.

const ENGINE = 'grammar-rules 1.2';

const VOCAB = new Set(('adverb adverbs adverbial adjective adjectival adjectives pronoun pronouns personal subject object objects ' +
  'complement noun nouns nominal phrase clause clauses relative defining nondefining restrictive identifying modifies modify ' +
  'modifying modified qualifies qualify qualifying describes describe describing preposition prepositional conjunction ' +
  'determiner condition conditional concession concessive reason purpose result consequence manner frequency comparison ' +
  'temporal demonstrative possessive reflexive interrogative direct indirect information identifies identify expresses ' +
  'explains shows states function functions cause causal place degree effect outcome predicative because although before ' +
  'whose which where while subordinate dependent sentence meaning completes verb verbs').split(/\s+/));

const NEGATORS = new Set(['not', 'never', 'no', 'isnt', 'doesnt', 'cannot', 'cant', 'neither', 'nor', 'wasnt', 'arent', 'dont', 'didnt', 'wont']);

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Normalise: lower case, straight quotes, "/" → " or ", hyphens → space, clause punctuation → " | " boundary.
function normalize(text, extraVocab = []) {
  let t = String(text || '').toLowerCase()
    .replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"')
    .replace(/(\w)'(\w)/g, '$1$2')           // isn't → isnt
    .replace(/\//g, ' or ')
    .replace(/[-–—]/g, ' ')
    .replace(/[,;:.!?()\[\]]/g, ' | ')
    .replace(/["']/g, ' ')
    .replace(/[^a-z0-9| ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const vocab = new Set([...VOCAB, ...extraVocab]);
  const tokens = t.split(' ').filter(Boolean).map((tok) => {
    if (tok === '|' || vocab.has(tok) || tok.length < 5) return tok;
    let best = null, bestD = 99;
    for (const v of vocab) {
      if (Math.abs(v.length - tok.length) > 2) continue;
      const d = lev(tok, v);
      if (d < bestD) { bestD = d; best = v; }
    }
    const limit = tok.length >= 9 ? 2 : 1;
    return bestD <= limit ? best : tok;
  });
  return tokens.join(' ');
}

function negatedBefore(str, index, lookback = 4) {
  const before = str.slice(0, index).trim().split(' ');
  for (let i = before.length - 1, k = 0; i >= 0 && k < lookback; i--, k++) {
    const w = before[i];
    if (w === '|' || w === 'but') break;
    if (NEGATORS.has(w)) return true;
  }
  return false;
}

function prevWords(str, index, n) {
  return str.slice(0, index).trim().split(' ').filter((w) => w && w !== '|').slice(-n);
}

// Find all matches for ordered [label, regex] patterns, blanking each match so nested patterns don't double count.
function scan(str, patterns) {
  let work = ' ' + str + ' ';
  const found = [];
  for (const [label, re, extra] of patterns) {
    const g = new RegExp(re.source, 'g');
    let m;
    while ((m = g.exec(work))) {
      const idx = m.index;
      found.push({ label, text: m[0].trim(), index: idx, negated: negatedBefore(work, idx), extra, prev: prevWords(work, idx, 3) });
      work = work.slice(0, idx) + ' '.repeat(m[0].length) + work.slice(idx + m[0].length);
      g.lastIndex = idx + m[0].length;
    }
  }
  return found;
}

const CATEGORY_PATTERNS = [
  ['relative clause', /\b(?:relative|adjectival|adjective)(?: or (?:relative|adjectival|adjective))? clause\b/],
  ['noun clause', /\b(?:noun|nominal)(?: or (?:noun|nominal))? clause\b/],
  ['adverbial clause', /\badverb(?:ial)? clause\b/],
  ['noun phrase', /\b(?:noun|nominal) (?:phrase|group)\b/],
  ['adverbial phrase', /\badverb(?:ial)? phrase\b/],
  ['adjectival phrase', /\badjectiv(?:al|e) phrase\b/],
  ['prepositional phrase', /\bprepositional phrase\b/],
  ['verb phrase', /\bverb phrase\b/],
  ['possessive pronoun', /\bpossessive pronoun\b/],
  ['relative pronoun', /\brelative pronoun\b/],
  ['demonstrative pronoun', /\bdemonstrative pronoun\b/],
  ['reflexive pronoun', /\breflexive pronoun\b/],
  ['interrogative pronoun', /\binterrogative pronoun\b/],
  ['object pronoun', /\b(?:object|objective) pronoun\b/],
  ['personal pronoun', /\bpersonal pronoun\b/],
  ['subject pronoun', /\b(?:subject|subjective|nominative) pronoun\b/],
  ['pronoun', /\bpronouns?\b/],
  ['adverb', /\badverbs?\b/],
  ['adjective', /\badjectives?\b|\badjectival\b/],
  ['noun', /\bnouns?\b/],
  ['verb', /\bverbs?\b/],
  ['preposition', /\bprepositions?\b/],
  ['conjunction', /\bconjunctions?\b/],
  ['determiner', /\bdeterminers?\b|\barticle\b/],
  ['generic clause', /\b(?:subordinate|dependent|main|independent)? ?clause\b/],
  ['generic phrase', /\bphrase\b/],
];

const FUNCTION_CUE = /^(?:modifies|modify|modifying|qualifies|qualify|qualifying|describes|describing|of|the|to)$/;

function detectCategories(norm) {
  return scan(norm, CATEGORY_PATTERNS).filter((f) => {
    // "modifies the verb worked" — a category word used to describe the target, not as the answer's name.
    const p = f.prev;
    return !(p.length && FUNCTION_CUE.test(p[p.length - 1])) && !p.some((w) => /^(modif|qualif|describ)/.test(w));
  });
}

const SUBTYPE_PATTERNS = {
  relative: [
    ['non-defining', /\bnon ?(?:defining|restrictive|identifying)\b/],
    ['defining', /\b(?:defining|restrictive|identifying)\b/],
  ],
  adverbial: [
    ['time', /\b(?:time|temporal)\b/],
    ['place', /\bplace\b/],
    ['manner', /\bmanner\b/],
    ['reason', /\b(?:reason|cause|causal)\b/],
    ['purpose', /\bpurpose\b/],
    ['result', /\b(?:result|consequence|effect)\b/],
    ['condition', /\b(?:condition|conditional)\b/],
    ['concession', /\b(?:concession|concessive|contrast)\b/],
    ['comparison', /\b(?:comparison|comparative)\b/],
    ['degree', /\bdegree\b/],
    ['frequency', /\bfrequency\b/],
  ],
};

function familyFor(labels) {
  if (labels.some((l) => /relative|adjectiv/.test(l))) return 'relative';
  if (labels.some((l) => /adverb/.test(l))) return 'adverbial';
  return null;
}

function result(awarded, certain, evidence, reason, feedback) {
  return { awarded, certain, evidence: evidence.filter(Boolean), reason, feedback };
}

function wordCount(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }

// ---- category (grammatical name) --------------------------------------------------------------------------
function markCategory(answer, rule) {
  const norm = normalize(answer);
  const cats = detectCategories(norm);
  const specific = cats.filter((c) => !c.label.startsWith('generic'));
  const positive = specific.filter((c) => !c.negated);
  const acceptedPos = positive.filter((c) => rule.accept.includes(c.label));
  const otherPos = positive.filter((c) => !rule.accept.includes(c.label));
  const acceptedNeg = specific.filter((c) => c.negated && rule.accept.includes(c.label));

  if (acceptedPos.length && otherPos.length) {
    return result(false, true, [acceptedPos[0].text, otherPos[0].text],
      `Names more than one category (“${acceptedPos[0].text}” and “${otherPos[0].text}”) — contradictory.`,
      'Your answer names two different categories.');
  }
  if (!acceptedPos.length && acceptedNeg.length) {
    return result(false, true, [acceptedNeg[0].text], `The correct name is negated (“not … ${acceptedNeg[0].text}”).`, 'Not correct.');
  }
  if (!acceptedPos.length && otherPos.length) {
    return result(false, true, [otherPos[0].text], `Identifies it as “${otherPos[0].text}”; scheme expects ${rule.accept.join(' / ')}.`, 'Not the correct grammatical name.');
  }
  if (!acceptedPos.length) {
    if (cats.some((c) => c.label === 'generic clause') && wordCount(answer) <= 4) {
      return result(false, true, [], 'Too general: names a clause without saying what kind.', 'Your answer is too general.');
    }
    if (!String(answer).trim()) return result(false, true, [], 'No answer.', 'No answer given.');
    if (wordCount(answer) <= 2) return result(false, true, [], 'Does not name a recognised grammatical category.', 'Not the correct grammatical name.');
    return result(false, false, [], 'No recognised category name; needs semantic check.', '');
  }
  // Optional subtype: if stated, it must be right.
  if (rule.subtypeAccept) {
    const fam = familyFor(rule.accept);
    const subs = fam ? scan(norm, SUBTYPE_PATTERNS[fam]).filter((s) => !s.negated) : [];
    const wrong = subs.filter((s) => !rule.subtypeAccept.includes(s.label));
    if (wrong.length) {
      return result(false, true, [acceptedPos[0].text, wrong[0].text],
        `Correct name but states the wrong type (“${wrong[0].text}”).`, 'The type you stated is not correct.');
    }
  }
  return result(true, true, [acceptedPos[0].text], `Correctly names it as ${acceptedPos[0].text}.`, 'Correct.');
}

// ---- subtype (¼ mark in name-and-type questions) --------------------------------------------------------------
function markSubtype(answer, rule) {
  if (!String(answer).trim()) return result(false, true, [], 'No answer.', 'No answer given.');
  const nameCheck = markCategory(answer, { kind: 'category', accept: rule.requires });
  if (!nameCheck.awarded) {
    return result(false, nameCheck.certain, [], 'Type mark needs the correct clause name first.', 'The type mark needs the correct clause name.');
  }
  const fam = familyFor(rule.requires);
  const norm = normalize(answer);
  const subs = scan(norm, SUBTYPE_PATTERNS[fam]);
  const pos = subs.filter((s) => !s.negated);
  const ok = pos.filter((s) => rule.accept.includes(s.label));
  const bad = pos.filter((s) => !rule.accept.includes(s.label));
  if (ok.length && bad.length) return result(false, true, [ok[0].text, bad[0].text], 'States two different types — contradictory.', 'Your answer gives two different types.');
  if (ok.length) return result(true, true, [ok[0].text], `Correct type: ${ok[0].label}.`, 'Correct type.');
  if (bad.length) return result(false, true, [bad[0].text], `Wrong type (“${bad[0].text}”).`, 'The type is not correct.');
  if (subs.length) return result(false, true, [subs[0].text], 'The type is negated.', 'The type is not correct.');
  return result(false, true, [], 'Type not stated.', 'The type was not stated.');
}

// ---- function --------------------------------------------------------------------------------------------------
const ROLE_PATTERNS = [
  ['prep_object', /\b(?:object|complement) of (?:the )?preposition\b|\bprepositional (?:object|complement)\b|\b(?:object|complement) of (?:the )?(?:word )?about\b/, 'strong'],
  ['complement', /\bsubject complement\b|\bcomplement\b|\bcompletes? (?:the )?meaning\b|\bpredicative\b/, 'strong'],
  ['indirect_object', /\bindirect object\b/, 'strong'],
  ['object', /\b(?:direct )?object\b/, 'strong'],
  ['subject', /\bsubject\b/, 'strong'],
  ['modify', /\bmodif\w*|\bqualif\w*|\bdescrib\w*|\badjunct\b|\blimits?\b/, 'strong'],
  ['modify', /\b(?:tells?|shows?|showing|states?|stating|explains?|explaining|says?|indicates?|indicating|expresses?|expressing)\b(?: us)?(?: \w+)? (?:how|when|why|where|which|the (?:time|reason|purpose|condition|manner))\b|\b(?:gives?|giving|adds?|adding|provides?|providing)\b(?: \w+){0,2} (?:information|detail|details)\b|\bidentif\w*|\bspecif\w*|\brelates? to\b|\brefers? to\b|\bdefines?\b/, 'weak'],
  ['result', /\bresult\w*|\bconsequen\w*|\beffect\b|\boutcome\b/, 'weak'],
];

function findPhrase(norm, phrase) {
  const p = phrase.toLowerCase().replace(/\s+/g, ' ').trim();
  const re = new RegExp('(^|\\s)' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)', 'g');
  const hits = [];
  let m;
  while ((m = re.exec(norm))) hits.push({ index: m.index + m[1].length, negated: negatedBefore(norm, m.index + m[1].length, 3) });
  return hits;
}

function markFunction(answer, rule) {
  if (!String(answer).trim()) return result(false, true, [], 'No answer.', 'No answer given.');
  const targetVocab = rule.targets.flatMap((t) => t.toLowerCase().split(/\s+/));
  const norm = normalize(answer, [...targetVocab, ...(rule.others || [])]);
  const roles = scan(norm, ROLE_PATTERNS);
  const pos = roles.filter((r) => !r.negated);
  const accepted = pos.filter((r) => rule.roles.includes(r.label));
  // "complement of the subject" — a role word after "of (the)" names what is being described, not a second role.
  const describedOnly = (r) => { const p = r.prev; return p[p.length - 1] === 'of' || (p[p.length - 1] === 'the' && p[p.length - 2] === 'of'); };
  const conflicting = pos.filter((r) => !rule.roles.includes(r.label) && r.extra === 'strong' && !describedOnly(r));
  const acceptedNeg = roles.filter((r) => r.negated && rule.roles.includes(r.label));

  const targetHits = rule.targets.map((t) => ({ t, hits: findPhrase(norm, t) })).filter((x) => x.hits.length);
  const targetPos = targetHits.filter((x) => x.hits.some((h) => !h.negated));
  const othersPresent = (rule.others || []).filter((w) => findPhrase(norm, w).length);

  if (accepted.length && conflicting.length) {
    return result(false, true, [accepted[0].text, conflicting[0].text],
      `States two different functions (“${accepted[0].text}” and “${conflicting[0].text}”) — contradictory.`, 'Your answer gives two different functions.');
  }
  if (!accepted.length && conflicting.length) {
    return result(false, true, [conflicting[0].text], `Gives the wrong function (“${conflicting[0].text}”).`, 'Not the correct function.');
  }
  if (!accepted.length && acceptedNeg.length) {
    return result(false, true, [acceptedNeg[0].text], 'The correct function is negated.', 'Not correct.');
  }
  if (accepted.length && targetHits.length && !targetPos.length) {
    return result(false, true, [accepted[0].text], 'The word concerned is negated.', 'Not correct.');
  }
  if (othersPresent.length >= 2) {
    return result(false, false, [], `Mentions several other words from the passage (${othersPresent.join(', ')}); cannot apply the scheme reliably.`, '');
  }
  if (accepted.length && targetPos.length) {
    return result(true, true, [accepted[0].text, targetPos[0].t], `Correct function (${accepted[0].text}) and identifies “${targetPos[0].t}”.`, 'Correct.');
  }
  if (accepted.length && !targetPos.length) {
    const stems = rule.targets.filter((t) => !t.includes(' ') && t.length >= 5).map((t) => t.slice(0, t.length - 2));
    const variant = stems.some((st) => new RegExp('\\b' + st).test(norm));
    if (wordCount(answer) <= 10 && !variant) {
      return result(false, true, [accepted[0].text], 'States the function but does not identify the word or expression concerned (instruction 3).', 'Say which word or expression it relates to.');
    }
    return result(false, false, [accepted[0].text], 'Function stated but the word concerned is not clearly identified; needs semantic check.', '');
  }
  if (wordCount(answer) <= 2 && !targetPos.length) {
    return result(false, true, [], 'Does not state a grammatical function.', 'Not the correct function.');
  }
  if (wordCount(answer) <= 1) {
    return result(false, true, [], 'Only names a word; no function stated (keyword alone earns no mark).', 'Not the correct function.');
  }
  return result(false, false, targetPos.map((x) => x.t), 'Function wording not recognised by the rules; needs semantic check.', '');
}

// ---- clause copying --------------------------------------------------------------------------------------------
function clauseTokens(s) {
  return String(s || '').toLowerCase().replace(/[‘’`´]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/'/g, '')
    .split(/\s+/).filter(Boolean);
}
const tokEq = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1);
function seqEq(a, b) { return a.length === b.length && a.every((t, i) => tokEq(t, b[i])); }
function contains(hay, needle) {
  for (let i = 0; i + needle.length <= hay.length; i++) if (seqEq(hay.slice(i, i + needle.length), needle)) return true;
  return false;
}

function markClause(answer, rule) {
  const a = clauseTokens(answer), e = clauseTokens(rule.text);
  if (!a.length) return result(false, true, [], 'No answer.', 'No answer given.');
  if (seqEq(a, e)) return result(true, true, [String(answer).trim()], 'Copies the whole subordinate clause.', 'Correct.');
  if (seqEq(a, e.slice(1))) return result(false, true, [String(answer).trim()], 'Omits the introductory word of the clause (instruction 4).', 'Include the introductory word.');
  if (a.length > e.length && contains(a, e)) return result(false, true, [String(answer).trim()], 'Includes words that are outside the subordinate clause.', 'Your answer includes words outside the clause.');
  if (a.length < e.length && contains(e, a)) return result(false, true, [String(answer).trim()], 'Copies only part of the clause.', 'Your answer is incomplete.');
  return result(false, true, [], 'Not the subordinate clause.', 'Not the subordinate clause.');
}

function applyRule(answer, rule) {
  switch (rule.kind) {
    case 'category': return markCategory(answer, rule);
    case 'subtype': return markSubtype(answer, rule);
    case 'function': return markFunction(answer, rule);
    case 'clause': return markClause(answer, rule);
    default: return result(false, false, [], `Unsupported rule kind “${rule.kind}”.`, '');
  }
}

module.exports = { ENGINE, applyRule, normalize, lev, wordCount };
