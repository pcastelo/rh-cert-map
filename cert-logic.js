(function (root) {
  "use strict";

  var SMALL_WORDS = { in: 1, of: 1, on: 1, to: 1, or: 1, an: 1, at: 1, by: 1, as: 1 };

  function evaluateLevel(rule, passed, nodeResults) {
    if (rule.type === "any") {
      var achieved = rule.codes.some(function (code) { return passed.has(code); });
      return { achieved: achieved, progress: achieved ? 1 : 0 };
    }
    if (rule.type === "all") {
      var count = rule.codes.filter(function (code) { return passed.has(code); }).length;
      return { achieved: count === rule.codes.length, progress: count / rule.codes.length };
    }
    if (rule.type === "meta") {
      var total = rule.requires.length;
      var done = rule.requires.filter(function (id) {
        return nodeResults && nodeResults[id] && nodeResults[id].achieved;
      }).length;
      return { achieved: done === total, progress: total > 0 ? done / total : 0 };
    }
    if (rule.type === "metaPlus") {
      var reqDone = rule.requires.filter(function (id) {
        return nodeResults && nodeResults[id] && nodeResults[id].achieved;
      }).length;
      var specialist = rule.specialist || [];
      var specDone = Math.min(rule.minSpecialist, specialist.filter(function (code) {
        return passed.has(code);
      }).length);
      var combined = rule.requires.length + rule.minSpecialist;
      var metaAchieved = reqDone === rule.requires.length && specDone >= rule.minSpecialist;
      return { achieved: metaAchieved, progress: Math.min(1, (reqDone + specDone) / combined) };
    }
    return { achieved: false, progress: 0 };
  }

  function evaluateProduct(product, passed) {
    var results = {};
    for (var i = 0; i < product.nodes.length; i++) {
      var node = product.nodes[i];
      results[node.id] = evaluateLevel(node.rule, passed, results);
    }
    return results;
  }

  // Architect rules list the specialist node's exams, so a code is written once.
  function bindArchitectSpecialists(products) {
    products.forEach(function (product) {
      var specialist = product.nodes.find(function (node) { return node.id === "specialist"; });
      var architect = product.nodes.find(function (node) { return node.id === "architect"; });
      if (!specialist || !architect || architect.rule.type !== "metaPlus") return;
      architect.rule.specialist = (specialist.rule.codes || []).slice();
    });
  }

  function normalizeCredName(name) {
    return name.toLowerCase().replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  }

  function wordSet(str) {
    return new Set(str.split(/\s+/).filter(function (word) {
      if (word.length > 2) return true;
      return word.length === 2 && !SMALL_WORDS[word];
    }));
  }

  function wordOverlap(a, b) {
    var setA = wordSet(a);
    var setB = wordSet(b);
    if (setA.size === 0 || setB.size === 0) return 0;
    var common = 0;
    setA.forEach(function (word) { if (setB.has(word)) common++; });
    return common / Math.max(setA.size, setB.size);
  }

  function extractRole(normalized) {
    var match = normalized.match(/certified\s+(\w+)/);
    return match ? match[1] : null;
  }

  function matchCredentialsToExams(credentials, exams, aliases) {
    var matched = new Set();
    var unmatched = [];
    var expiryByCode = {};
    var aliasMap = aliases || {};
    var examList = exams || [];

    function remember(code, cred) {
      matched.add(code);
      var expiry = cred && typeof cred === "object" ? cred.expiry : "";
      if (expiry && !expiryByCode[code]) expiryByCode[code] = expiry;
    }

    credentials.forEach(function (cred) {
      var credName = typeof cred === "string" ? cred : cred.name;
      var credNorm = normalizeCredName(credName);

      var aliasCode = aliasMap[credNorm];
      if (aliasCode) {
        if (Array.isArray(aliasCode)) {
          aliasCode.forEach(function (code) { remember(code, cred); });
        } else {
          remember(aliasCode, cred);
        }
        return;
      }

      var exactMatch = examList.find(function (exam) {
        return credNorm === normalizeCredName(exam.name);
      });
      if (exactMatch) { remember(exactMatch.code, cred); return; }

      var credRole = extractRole(credNorm);
      var credWords = wordSet(credNorm);
      var bestMatch = null;
      var bestScore = 0;
      examList.forEach(function (exam) {
        var examNorm = normalizeCredName(exam.name);
        var examRole = extractRole(examNorm);
        if (credRole && examRole && credRole !== examRole) return;
        var examWords = wordSet(examNorm);
        var allExamWordsInCred = Array.from(examWords).every(function (word) { return credWords.has(word); });
        if (!allExamWordsInCred) return;
        var score = wordOverlap(credNorm, examNorm);
        if (score >= 0.7 && score > bestScore) {
          bestScore = score;
          bestMatch = exam.code;
        }
      });
      if (bestMatch) remember(bestMatch, cred);
      else unmatched.push(cred);
    });
    return { matched: matched, unmatched: unmatched, expiryByCode: expiryByCode };
  }

  function credentialContainsPhrase(text, phrase) {
    if (!phrase) return false;
    var escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?:^|[^a-z0-9])" + escaped + "(?:[^a-z0-9]|$)").test(text);
  }

  // Shared by filterAchievedCredentials and findMismatchedNodes: resolves a
  // normalized credential name to the single node within `product` it names
  // (e.g. "Architect in Enterprise Linux" -> the Architect node), preferring
  // the longest-named node when more than one node name appears in the text.
  function resolveCredentialNodeForProduct(credNorm, product) {
    var productNorm = normalizeCredName(product.name);
    if (!credentialContainsPhrase(credNorm, productNorm)) return null;

    var matchedNodes = product.nodes.filter(function (node) {
      return credentialContainsPhrase(credNorm, normalizeCredName(node.name));
    });
    if (matchedNodes.length === 0) return null;

    matchedNodes.sort(function (a, b) { return b.name.length - a.name.length; });
    return matchedNodes[0];
  }

  function filterAchievedCredentials(unmatchedCreds, products, passedExams) {
    var passed = passedExams instanceof Set ? passedExams : new Set(passedExams || []);
    return (unmatchedCreds || []).filter(function (cred) {
      var credNorm = normalizeCredName(cred.name || "");
      for (var p = 0; p < products.length; p++) {
        var product = products[p];
        var node = resolveCredentialNodeForProduct(credNorm, product);
        if (!node) continue;

        var results = evaluateProduct(product, passed);
        if (results[node.id].achieved) return false;
      }
      return true;
    });
  }

  // For meta/metaPlus nodes (Engineer, Architect) only: flags "<product
  // name>:<node id>" when a Current Credential names that node but the
  // node's own rule does not evaluate to achieved from matched exams alone.
  // Red Hat sometimes grants these levels via legacy paths the site cannot
  // reconstruct; this surfaces that gap without changing passedExams or
  // which credentials appear in Active Legacy Credentials.
  function findMismatchedNodes(unmatchedCreds, products, passedExams) {
    var passed = passedExams instanceof Set ? passedExams : new Set(passedExams || []);
    var mismatched = new Set();
    (unmatchedCreds || []).forEach(function (cred) {
      var credNorm = normalizeCredName(cred.name || "");
      for (var p = 0; p < products.length; p++) {
        var product = products[p];
        var node = resolveCredentialNodeForProduct(credNorm, product);
        if (!node) continue;
        if (node.rule.type !== "meta" && node.rule.type !== "metaPlus") continue;

        var results = evaluateProduct(product, passed);
        if (!results[node.id].achieved) {
          mismatched.add(product.name + ":" + node.id);
        }
      }
    });
    return mismatched;
  }

  function getExamLevel(examName) {
    var lower = examName.toLowerCase();
    if (lower.includes("technologist")) return "Technologist";
    if (lower.includes("specialist")) return "Specialist";
    if (lower.includes("advanced") && lower.includes("system administrator")) return "Advanced System Administrator";
    if (lower.includes("system administrator")) return "System Administrator";
    if (lower.includes("advanced") && lower.includes("developer")) return "Advanced Developer";
    if (lower.includes("developer")) return "Developer";
    return "Other";
  }

  function mergeTranscriptCodes(transcriptMatched, credentialMatchedCodes, credentialExpiryByCode, transcriptExams) {
    var codes = new Set(credentialMatchedCodes);
    transcriptMatched.forEach(function (code) {
      if (credentialMatchedCodes.has(code)) codes.add(code);
    });

    var expiryByCode = {};
    Object.keys(credentialExpiryByCode || {}).forEach(function (code) {
      expiryByCode[code] = credentialExpiryByCode[code];
    });
    (transcriptExams || []).forEach(function (exam) {
      if (codes.has(exam.code) && !expiryByCode[exam.code] && exam.date) {
        expiryByCode[exam.code] = exam.date;
      }
    });

    return { codes: codes, expiryByCode: expiryByCode };
  }

  function isRedHatVerifyDocument(doc) {
    if (!doc || !doc.body) return false;
    var bodyText = doc.body.textContent || "";
    if (bodyText.includes("is not a valid Certification ID")) return true;
    if (bodyText.includes("No certifications found")) return true;

    var hasOwner = false;
    var tds = doc.querySelectorAll("td");
    for (var i = 0; i < tds.length; i++) {
      if (tds[i].textContent.trim() === "Owner:") {
        hasOwner = true;
        break;
      }
    }
    if (!hasOwner) return false;

    var headings = doc.querySelectorAll("h3");
    for (var h = 0; h < headings.length; h++) {
      if (headings[h].textContent.trim() === "Current Credentials") return true;
    }
    return false;
  }

  root.CertLogic = {
    evaluateLevel: evaluateLevel,
    evaluateProduct: evaluateProduct,
    bindArchitectSpecialists: bindArchitectSpecialists,
    normalizeCredName: normalizeCredName,
    wordSet: wordSet,
    matchCredentialsToExams: matchCredentialsToExams,
    credentialContainsPhrase: credentialContainsPhrase,
    filterAchievedCredentials: filterAchievedCredentials,
    findMismatchedNodes: findMismatchedNodes,
    getExamLevel: getExamLevel,
    mergeTranscriptCodes: mergeTranscriptCodes,
    isRedHatVerifyDocument: isRedHatVerifyDocument,
  };
})(typeof window !== "undefined" ? window : globalThis);
