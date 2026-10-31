// ===== Automatic topics =====
// Topics are found in two ways:
//   1. By meaning (ai-topics.js): a small AI model compares each sentence with the
//      example phrases below and picks the topics that fit best.
//   2. By keywords (further down): used as a small extra hint for the AI, and on
//      their own if the AI model can't be loaded (e.g. no internet).

// ----- Example phrases for each topic -----
// Short English phrases describing what each topic is about. The AI model
// understands many languages, so English examples work for Polish and Turkish too.
// Adding more varied examples makes a topic easier to recognise.
const TOPIC_EXAMPLES = {
  Food: [
    "eating a meal", "food and drinks", "cooking dinner in the kitchen",
    "ordering at a restaurant or café", "coffee, tea, bread and cheese", "I am hungry",
  ],
  Travel: [
    "travelling to another country", "taking a train, bus or plane", "going on holiday",
    "booking a hotel and buying tickets", "asking for directions", "driving a car to the city",
  ],
  Work: [
    "my job and my office", "talking with colleagues and the boss", "a meeting at work",
    "salary and career", "working long hours", "a job interview",
  ],
  Family: [
    "my parents and children", "brothers, sisters and relatives", "spending time with my family",
    "my friends", "a boyfriend or girlfriend", "a wedding and marriage",
  ],
  Home: [
    "my house or apartment", "rooms and furniture", "cleaning the house",
    "the neighbours and the rent", "the garden, door and windows",
  ],
  Health: [
    "feeling sick or in pain", "going to the doctor or hospital", "taking medicine from the pharmacy",
    "having a headache or a fever", "sleeping and feeling tired", "the body and exercise for health",
  ],
  Shopping: [
    "buying things in a shop", "prices and money", "paying by card or in cash",
    "going to the supermarket", "something is too expensive or cheap", "the bank and saving money",
  ],
  Nature: [
    "the weather today", "rain, snow and sunshine", "animals and plants",
    "mountains, forests, rivers and the sea", "the seasons of the year", "it is hot or cold outside",
  ],
  Time: [
    "days of the week and dates", "what time it is", "today, tomorrow and yesterday",
    "a schedule and appointments", "next week or last year", "being early or late",
  ],
  Feelings: [
    "emotions and feelings", "being happy or sad", "love and fear",
    "feeling angry, bored or excited", "I am worried and nervous", "feeling lonely",
  ],
  Hobbies: [
    "sports and playing football", "listening to music and singing", "watching films and reading books",
    "playing games", "free time and hobbies", "dancing, painting and taking photos",
  ],
  School: [
    "school, classes and teachers", "studying for an exam", "learning a foreign language",
    "university students", "doing homework", "words and grammar",
  ],
  Greetings: [
    "saying hello", "saying goodbye", "thank you and please", "how are you?",
    "nice to meet you", "sorry, excuse me",
  ],
};

// ----- Keywords for each topic -----
// A sentence gets every topic whose keywords appear in it.
//
// How to write keywords (always in lowercase):
//   "bread"        matches only the exact word "bread"
//   "bread*"       matches any word starting with "bread": bread, breads, breadcrumbs...
//   "good morning" matches those words next to each other
//
// The * is important for Polish and Turkish, where word endings change a lot:
//   "herbat*" matches herbata, herbaty, herbatę, herbatą...
//   "kahve*"  matches kahve, kahveyi, kahvesi, kahveler...
//
// Feel free to add words! Topic names are one word, the same in all languages.

const TOPIC_KEYWORDS = {
  "Food": {
    English: [
      "food*", "eat*", "ate", "drink*", "drank", "breakfast*", "lunch*", "dinner*", "supper",
      "meal*", "restaurant*", "cafe*", "café*", "coffee*", "tea", "teas", "water", "bread*",
      "cheese*", "meat*", "chicken*", "fish", "rice", "soup*", "apple*", "banana*", "fruit*",
      "vegetable*", "salad*", "cake*", "hungry", "thirsty", "cook*", "menu*", "delicious",
      "tasty", "beer*", "wine*", "milk*", "egg", "eggs", "sugar*", "pizza*",
    ],
    Polish: [
      "jedzeni*", "jeść", "jem", "jesz", "zjeść", "zjem*", "pić", "piję", "pijesz",
      "śniadani*", "obiad*", "kolacj*", "posiłek", "posiłk*", "restaurac*", "kawiarni*",
      "kawa", "kawy", "kawę", "kawą", "kawie", "herbat*", "wod*", "chleb*", "ser", "sera",
      "serem", "sery", "mięs*", "kurczak*", "ryb*", "ryż*", "zup*", "jabł*", "banan*", "owoc*",
      "warzyw*", "sałat*", "ciast*", "głodn*", "spragnion*", "gotuj*", "gotował*", "menu",
      "pyszn*", "smaczn*", "piw*", "wino", "mlek*", "mleka", "jaj*", "cukier", "cukru", "pizz*",
    ],
    Turkish: [
      "yeme*", "yiye*", "yiyor*", "içmek*", "içiyor*", "içti*", "içecek*", "kahvaltı*",
      "öğle yemeğ*", "akşam yemeğ*", "restoran*", "lokanta*", "kafe*", "kahve*", "çay", "çayı",
      "çaylar*", "su", "suyu", "sular*", "ekme*", "peynir*", "et", "eti", "etler*", "tavu*",
      "balık*", "balığ*", "pilav*", "pirinç*", "çorba*", "elma*", "muz*", "meyve*", "sebze*",
      "salata*", "pasta*", "kek", "acıktı*", "susa*", "pişir*", "menü*", "lezzetli*", "nefis",
      "bira*", "şarap*", "süt", "sütü", "yumurta*", "şeker*", "pizza*",
    ],
  },

  "Travel": {
    English: [
      "travel*", "trip*", "journey*", "holiday*", "vacation*", "airport*", "plane*", "flight*",
      "fly", "flying", "train", "trains", "station*", "bus", "buses", "taxi*", "car", "cars",
      "ticket*", "hotel*", "passport*", "luggage", "suitcase*", "beach*", "abroad", "tourist*",
      "map", "maps", "road*", "drive", "driving", "visit*", "country", "countries",
    ],
    Polish: [
      "podróż*", "wycieczk*", "wakacj*", "urlop*", "lotnisk*", "samolot*", "lot", "lotu",
      "pociąg*", "dworzec", "dworc*", "stacj*", "autobus*", "taksówk*", "samochód", "samochod*",
      "auto", "auta", "autem", "bilet*", "hotel*", "paszport*", "bagaż*", "walizk*", "plaż*",
      "zagranic*", "turyst*", "mapa", "mapy", "mapę", "jechać", "jadę", "jedziesz", "jedzie*",
      "lecieć", "lecę", "zwiedza*",
    ],
    Turkish: [
      "seyahat*", "gezi*", "tatil*", "havaalan*", "havalimanı*", "uçak*", "uçağ*", "uçuş*",
      "tren*", "istasyon*", "otobüs*", "taksi*", "araba*", "bilet*", "otel*", "pasaport*",
      "bavul*", "valiz*", "plaj*", "yurt dışı*", "turist*", "harita*", "yol", "yolu",
      "yolculuk*", "gidiyor*", "gitti*", "gideceğ*", "gitmek*",
    ],
  },

  "Work": {
    English: [
      "work*", "job*", "office*", "boss*", "colleague*", "meeting*", "salary*", "career*",
      "company", "companies", "client*", "project*", "manager*", "employ*", "interview*",
      "business*", "deadline*", "email*",
    ],
    Polish: [
      "prac*", "biur*", "szef*", "współpracowni*", "spotkani*", "pensj*", "wypłat*", "karier*",
      "firm*", "klient*", "projekt*", "menedżer*", "kierowni*", "zatrudni*",
      "rozmowa kwalifikacyjna", "biznes*", "termin*", "mail*",
    ],
    Turkish: [
      "iş", "işi", "işe", "işim", "işin", "işler*", "çalış*", "ofis*", "büro*", "patron*",
      "müdür*", "iş arkadaş*", "toplantı*", "maaş*", "kariyer*", "şirket*", "müşteri*",
      "proje*", "mülakat*", "e-posta*",
    ],
  },

  "Family": {
    English: [
      "family", "families", "mother*", "mom", "mum", "father*", "dad", "parent*", "brother*",
      "sister*", "son", "sons", "daughter*", "child*", "children", "kid", "kids", "baby",
      "babies", "husband*", "wife", "wives", "grandma*", "grandpa*", "grandmother*",
      "grandfather*", "uncle*", "aunt*", "cousin*", "friend*", "wedding*", "married",
    ],
    Polish: [
      "rodzin*", "matka", "matki", "matką", "mama", "mamę", "mamą", "mamie", "mamo", "ojc*",
      "tata", "taty", "tatę", "tatą", "tacie", "rodzic*", "brat", "brata", "bratem", "bracia*",
      "siostr*", "syn", "syna", "synem", "córk*", "dzieck*", "dzieci*", "niemowl*", "mąż",
      "męża", "mężem", "żon*", "babci*", "babcia", "dziad*", "wujek*", "wujk*", "ciocia*",
      "ciotk*", "cioci*", "kuzyn*", "przyjaci*", "chłopak*", "dziewczyn*", "ślub*", "żonaty",
      "zamężn*",
    ],
    Turkish: [
      "aile*", "anne*", "baba*", "ebeveyn*", "kardeş*", "abi*", "abla*", "oğul", "oğlu*", "kız",
      "kızı*", "kızım*", "çocu*", "bebe*", "kocam*", "kocası*", "kocan*", "eş", "eşi", "eşim",
      "büyükanne*", "büyükbaba*", "dede*", "nine*", "amca*", "dayı*", "teyze*", "hala", "halam*",
      "kuzen*", "arkada*", "sevgili*", "düğün*", "evli*",
    ],
  },

  "Home": {
    English: [
      "home*", "house*", "flat", "apartment*", "room*", "bedroom*", "kitchen*", "bathroom*",
      "living room", "bed", "beds", "sofa*", "garden*", "door*", "window*", "clean*", "rent*",
      "neighbo*",
    ],
    Polish: [
      "dom", "domu", "domem", "domy", "domów", "domach", "mieszkani*", "pokój", "pokoj*", "pokoi*",
      "sypialni*", "kuchni*", "łazien*", "salon*", "łóżk*", "kanap*", "ogród", "ogrod*", "drzwi",
      "okn*", "okien", "sprząt*", "wynaj*", "czynsz*", "sąsiad*", "sąsiedz*",
    ],
    Turkish: [
      "ev", "evi", "evim", "evin", "eve", "evde", "evden", "evler*", "daire*", "oda", "odası*",
      "odam*", "odada*", "mutfak*", "mutfağ*", "banyo*", "salon*", "yatak*", "yatağ*",
      "kanepe*", "bahçe*", "kapı*", "pencere*", "temizl*", "kira*", "komşu*",
    ],
  },

  "Health": {
    English: [
      "health*", "doctor*", "hospital*", "sick", "ill", "illness*", "pain*", "hurt*",
      "headache*", "medicine*", "pharmacy*", "fever*", "cough*", "tired", "sleep*", "head",
      "stomach*", "tooth", "teeth", "dentist*",
    ],
    Polish: [
      "zdrow*", "lekarz*", "szpital*", "chor*", "ból*", "boli", "bolą", "głow*", "lek", "leki",
      "leków", "lekarstw*", "aptek*", "gorączk*", "kaszel", "kaszl*", "zmęczon*", "spać",
      "śpię", "sen", "snu", "brzuch*", "ząb", "zęb*", "dentyst*",
    ],
    Turkish: [
      "sağlık*", "sağlığ*", "doktor*", "hastane*", "hasta*", "ağrı*", "ilaç*", "ilacı*",
      "eczane*", "ateş*", "öksür*", "yorgun*", "uyu*", "mide*", "diş*",
    ],
  },

  "Shopping": {
    English: [
      "shop*", "store*", "buy*", "bought", "price*", "cost*", "cheap*", "expensive", "money",
      "pay*", "paid", "cash", "card", "cards", "bank*", "sale", "sales", "market*",
      "supermarket*", "euro*", "dollar*",
    ],
    Polish: [
      "sklep*", "zakup*", "kupi*", "kupuj*", "kupuję", "cen*", "koszt*", "tani*", "drogie",
      "drogo", "pieniądz*", "pieniędz*", "płac*", "zapłac*", "gotówk*", "kart*", "bank*",
      "wyprzedaż*", "targ*", "rynek*", "supermarket*", "złot*", "euro",
    ],
    Turkish: [
      "alışveriş*", "mağaza*", "dükkan*", "satın*", "aldım", "almak", "fiyat*", "ucuz*",
      "pahalı*", "para", "paraya", "param*", "parası*", "paralar*", "ödemek*", "ödedi*",
      "ödüyor*", "nakit*", "kart*", "banka*", "indirim*", "pazar*", "market*", "süpermarket*",
      "lira*", "euro", "dolar*",
    ],
  },

  "Nature": {
    English: [
      "weather*", "rain", "raining", "rainy", "rained", "snow*", "sun", "sunny", "sunshine",
      "cloud*", "wind*", "storm*", "hot", "cold", "warm*", "temperature*", "tree*", "forest*",
      "mountain*", "river*", "sea", "lake*", "flower*", "animal*", "dog", "dogs", "cat", "cats",
      "bird*", "nature*", "spring", "summer*", "winter*", "autumn*",
    ],
    Polish: [
      "pogod*", "deszcz*", "pada", "śnieg*", "słońc*", "słoneczn*", "chmur*", "pochmurn*",
      "wiatr*", "wietrz*", "burz*", "gorąc*", "zimn*", "ciepł*", "temperatur*", "drzew*", "las",
      "lasu", "lesie", "góra", "góry", "górach", "gór", "rzek*", "morz*", "jezior*", "kwiat*",
      "zwierz*", "pies", "psa", "psem", "psy", "psów", "kot", "kota", "kotem", "koty", "kotów",
      "ptak*", "przyrod*", "natur*", "wiosn*", "lato", "latem", "zima", "zimą", "zimie",
      "jesie*",
    ],
    Turkish: [
      "hava", "havası*", "havalar*", "yağmur*", "kar", "kar yağ*", "güneş*", "bulut*",
      "rüzgar*", "rüzgâr*", "fırtına*", "sıcak*", "soğuk*", "ılık*", "ağaç*", "ağac*", "orman*",
      "dağ", "dağı", "dağlar*", "nehir*", "nehri*", "deniz*", "göl", "gölü", "göller*", "çiçe*",
      "hayvan*", "köpe*", "kedi*", "kuş", "kuşu", "kuşlar*", "doğa", "doğada", "doğayı",
      "ilkbahar*", "bahar*", "kış*", "sonbahar*",
    ],
  },

  "Time": {
    English: [
      "today", "tomorrow", "yesterday", "morning*", "evening*", "night*", "week*", "weekend*",
      "month*", "year*", "hour*", "minute*", "o'clock", "what time", "monday*", "tuesday*",
      "wednesday*", "thursday*", "friday*", "saturday*", "sunday*", "birthday*", "calendar*",
    ],
    Polish: [
      "dzisiaj", "dziś", "jutro", "wczoraj", "rano", "wieczor*", "wieczór", "noc", "nocy", "nocą",
      "tydzie*", "tygod*", "weekend*", "miesi*", "rok", "roku", "lat", "godzin*", "minut*",
      "poniedział*", "wtor*", "środa", "środę", "środy", "czwart*", "piąt*", "sobot*",
      "niedziel*", "urodzin*", "kalendarz*",
    ],
    Turkish: [
      "bugün*", "yarın*", "dün", "sabah*", "akşam*", "gece*", "hafta*", "yıl", "yılı*",
      "yıllar*", "sene*", "saat*", "dakika*", "pazartesi*", "salı*", "çarşamba*", "perşembe*",
      "cuma*", "cumartesi*", "pazar günü*", "doğum günü*", "takvim*",
    ],
  },

  "Feelings": {
    English: [
      "happy", "happiness", "sad*", "angry", "love*", "hate*", "afraid", "scared", "fear*",
      "worried", "worry", "bored*", "excited", "nervous", "lonely", "feel*", "glad", "upset",
    ],
    Polish: [
      "szczęśliw*", "szczęści*", "smut*", "zły", "zła", "złość*", "kocha*", "miłość*",
      "miłości", "nienawidz*", "boję", "boisz", "boi", "strach*", "martwi*", "nudz*",
      "znudzon*", "podekscytowan*", "zdenerwowan*", "samotn*", "czuję", "czujesz", "czuć",
      "czuje", "cieszę", "cieszy*", "zmartwion*",
    ],
    Turkish: [
      "mutlu*", "üzgün*", "üzül*", "kızgın*", "sinirli*", "sinirlen*", "sev*", "aşk*", "nefret*",
      "kork*", "endişe*", "sıkıl*", "sıkıcı*", "heyecan*", "yalnız*", "hisse*", "memnun*",
    ],
  },

  "Hobbies": {
    English: [
      "hobby", "hobbies", "sport*", "football*", "soccer*", "tennis*", "basketball*", "swim*",
      "run", "running", "gym*", "music*", "song*", "sing*", "guitar*", "piano*", "dance*",
      "dancing", "movie*", "film*", "cinema*", "book", "books", "read", "reading", "game*",
      "play", "playing", "played", "paint*", "photo*",
    ],
    Polish: [
      "hobby", "sport*", "piłk*", "tenis*", "koszyków*", "pływa*", "biega*", "siłowni*",
      "muzyk*", "piosenk*", "śpiew*", "gitar*", "pianin*", "tańcz*", "taniec", "tańca", "film*",
      "kino", "kina", "kinie", "książk*", "czyta*", "gra", "grać", "gram", "grasz", "gry", "grę",
      "grał*", "malow*", "maluj*", "zdjęci*", "fotograf*",
    ],
    Turkish: [
      "hobi*", "spor", "sporu", "spor yap*", "futbol*", "tenis*", "basketbol*", "yüzme*",
      "yüzüyor*", "koş*", "spor salonu*", "müzik*", "şarkı*", "gitar*", "piyano*", "dans*",
      "film*", "sinema*", "kitap*", "kitab*", "okumak*", "okuyor*", "okudu*", "oyun*", "oyna*",
      "resim*", "resm*", "fotoğraf*",
    ],
  },

  "School": {
    English: [
      "school*", "university*", "college*", "class", "classes", "classroom*", "lesson*",
      "teacher*", "student*", "study*", "studied", "learn*", "exam*", "test", "tests",
      "homework*", "language*", "word", "words", "grammar*", "course*",
    ],
    Polish: [
      "szkoł*", "szkol*", "uniwersyte*", "studi*", "studen*", "klas*", "lekcj*", "nauczyciel*",
      "uczeń", "uczni*", "uczę", "uczysz", "uczy", "uczyć", "uczymy", "nauk*", "egzamin*",
      "test*", "sprawdzian*", "zadanie domowe", "praca domowa", "język*", "słow*", "gramatyk*",
      "kurs*",
    ],
    Turkish: [
      "okul*", "üniversite*", "sınıf*", "ders*", "öğretmen*", "öğrenci*", "öğren*", "sınav*",
      "test*", "ödev*", "dil", "dili", "dilini", "dilde", "diller*", "kelime*", "gramer*",
      "dilbilgisi*", "kurs*",
    ],
  },

  "Greetings": {
    English: [
      "hello", "hi", "hey", "goodbye", "bye", "good morning", "good evening", "good night",
      "thanks", "thank you", "please", "sorry", "welcome", "how are you", "nice to meet you",
    ],
    Polish: [
      "cześć", "dzień dobry", "dobry wieczór", "dobranoc", "do widzenia", "hej", "siema",
      "dziękuję", "dzięki", "proszę", "przepraszam", "witam", "witaj*", "jak się masz",
      "miło mi",
    ],
    Turkish: [
      "merhaba", "selam", "günaydın", "iyi akşamlar", "iyi geceler", "hoşça kal", "güle güle",
      "görüşürüz", "teşekkür*", "sağ ol*", "lütfen", "özür dilerim", "pardon", "hoş geldin*",
      "nasılsın*", "memnun oldum",
    ],
  },
};

// The language codes used for lowercase letters (Turkish has its own: İ → i, I → ı)
const KEYWORD_LOCALES = { English: "en", Polish: "pl", Turkish: "tr" };

// Turn a sentence into " word word word " (lowercase, no punctuation),
// so keywords can be searched for with spaces around them
function wordsWithSpaces(text, locale) {
  const words = text.toLocaleLowerCase(locale).split(/[^\p{L}\p{M}'-]+/u);
  return " " + words.filter(Boolean).join(" ") + " ";
}

// Does this keyword appear in the sentence?
function keywordMatches(spacedText, keyword) {
  if (keyword.endsWith("*")) {
    return spacedText.includes(" " + keyword.slice(0, -1)); // Word starts with it
  }
  return spacedText.includes(" " + keyword + " "); // Exact word (or words)
}

// Find every topic that matches a sentence.
// If the sentence's language has keyword lists, only those are used.
// Otherwise (no language, or another language) all the lists are tried.
function detectTopics(text, language) {
  const languages = KEYWORD_LOCALES[language] ? [language] : Object.keys(KEYWORD_LOCALES);
  const found = [];

  Object.keys(TOPIC_KEYWORDS).forEach(function (topic) {
    const matches = languages.some(function (lang) {
      const spacedText = wordsWithSpaces(text, KEYWORD_LOCALES[lang]);
      const keywords = TOPIC_KEYWORDS[topic][lang] || [];
      return keywords.some(function (keyword) {
        return keywordMatches(spacedText, keyword);
      });
    });
    if (matches) {
      found.push(topic);
    }
  });

  return found;
}
