function stripDiacritics(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function normalizeNameToken(value = "") {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9']/g, "");
}

export function normalizeNamePhrase(value = "") {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]+/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function phoneticNameKey(value = "") {
  return normalizeNameToken(value)
    .replace(/([a-z])\1+/g, "$1")
    .replace(/[aeiouy]+/g, "a")
    .replace(/ght/g, "t")
    .replace(/gh/g, "g")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k");
}

function levenshtein(a = "", b = "") {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const rows = Array.from({ length: a.length + 1 }, (_, i) => i);

  for (let j = 1; j <= b.length; j += 1) {
    let prev = rows[0];
    rows[0] = j;
    for (let i = 1; i <= a.length; i += 1) {
      const temp = rows[i];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i] = Math.min(rows[i] + 1, rows[i - 1] + 1, prev + cost);
      prev = temp;
    }
  }

  return rows[a.length];
}

function maxNameDistance(a = "", b = "") {
  const length = Math.max(a.length, b.length);
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

function namePartScore(a = "", b = "") {
  const left = normalizeNameToken(a);
  const right = normalizeNameToken(b);
  if (!left || !right) return 0;
  if (left === right) return 4;

  const leftKey = phoneticNameKey(left);
  const rightKey = phoneticNameKey(right);
  if (leftKey && leftKey === rightKey) return 3;

  if (levenshtein(left, right) <= maxNameDistance(left, right)) return 2;
  if (
    leftKey &&
    rightKey &&
    levenshtein(leftKey, rightKey) <= Math.min(1, maxNameDistance(leftKey, rightKey))
  ) {
    return 1;
  }

  return 0;
}

function titleCaseWord(word = "") {
  return word ? `${word[0].toUpperCase()}${word.slice(1)}` : "";
}

function displayVariant(word = "") {
  return titleCaseWord(normalizeNameToken(word));
}

export function buildNameRecognitionVariants(...values) {
  const variants = new Set();
  const cleanedValues = values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  cleanedValues.forEach((value) => {
    variants.add(value);
    const words = normalizeNamePhrase(value).split(" ").filter(Boolean);
    if (!words.length) return;

    const wordVariants = words.map((word) => {
      const set = new Set([displayVariant(word)]);
      const vowelCollapsed = word
        .replace(/([a-z])\1+/g, "$1")
        .replace(/[aeiouy]+/g, "i");
      if (vowelCollapsed.length >= 2) set.add(titleCaseWord(vowelCollapsed));
      const softened = word
        .replace(/([a-z])\1+/g, "$1")
        .replace(/[aeiouy]+/g, "e");
      if (softened.length >= 2) set.add(titleCaseWord(softened));
      return Array.from(set).filter((item) => item.length >= 2);
    });

    wordVariants.flat().forEach((variant) => variants.add(variant));
    if (wordVariants.length >= 2) {
      wordVariants[0].forEach((first) => {
        wordVariants[wordVariants.length - 1].forEach((last) => {
          variants.add(`${first} ${last}`);
        });
      });
    }
  });

  return Array.from(variants)
    .map((value) => value.trim())
    .filter((value) => value.length >= 2 && value.length <= 32);
}

export function personNameRoughlyMatches(query, person) {
  if (!person) return false;

  const normalizedQuery = normalizeNamePhrase(query);
  if (!normalizedQuery) return false;

  const fullName = `${person.name ?? ""} ${person.surname ?? ""}`.trim();
  const normalizedFullName = normalizeNamePhrase(fullName);
  if (
    normalizedFullName.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedFullName)
  ) {
    return true;
  }

  const queryParts = normalizedQuery.split(" ").filter(Boolean);
  if (queryParts.length >= 2) {
    return Boolean(
      findBestPersonNameMatch(queryParts[0], queryParts[queryParts.length - 1], [
        person,
      ]),
    );
  }

  return (
    namePartScore(queryParts[0], person.name) >= 2 ||
    namePartScore(queryParts[0], person.surname) >= 2
  );
}

export function findBestPersonNameMatch(firstName, surname, people = []) {
  let bestMatch = null;
  let bestScore = 0;

  people.forEach((person) => {
    if (!person?.name || !person?.surname) return;
    const firstScore = namePartScore(firstName, person.name);
    const surnameScore = namePartScore(surname, person.surname);
    if (!firstScore || !surnameScore) return;

    const score = firstScore + surnameScore;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = person;
    }
  });

  return bestScore >= 5 ? bestMatch : null;
}

export function canonicalizeTranscriptNames(text, people = []) {
  const source = String(text ?? "");
  if (!source.trim() || !people.length) return source;

  const tokens = source.match(/[A-Za-zÀ-ÿ0-9']+|[^A-Za-zÀ-ÿ0-9']+/g) ?? [source];

  for (let i = 0; i < tokens.length - 2; i += 1) {
    const first = tokens[i];
    const separator = tokens[i + 1];
    const second = tokens[i + 2];

    if (!/^[A-Za-zÀ-ÿ0-9']+$/.test(first)) continue;
    if (!/^[A-Za-zÀ-ÿ0-9']+$/.test(second)) continue;
    if (/[A-Za-zÀ-ÿ0-9']/.test(separator)) continue;

    const match = findBestPersonNameMatch(first, second, people);
    if (!match) continue;

    tokens[i] = match.name;
    tokens[i + 2] = match.surname;
    i += 2;
  }

  return tokens.join("");
}
