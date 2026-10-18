# ManageHouse: ניהול הוצאות והכנסות

אפליקציית ווב לניהול הכספים של הבית: סקירה ותחזית חודשית, מעקב חודשי מול תקציב, התחייבויות קבועות, תובנות, פנסיה, שאלות פתוחות ופירוט כל התנועות.

**כתובות** (אותה אפליקציה, כניסה עם חשבון Google מורשה בלבד):
- <https://car-qr-counter.web.app> (Firebase Hosting)
- <https://gavishori.github.io/Manage_House/> (GitHub Pages, מתעדכן אוטומטית בכל push)

## איך זה בנוי

```
docs/                האפליקציה שמתפרסמת ב-Firebase Hosting וב-GitHub Pages (בלי שום נתון אישי)
  index.html         הדשבורד
  app.js             התחברות עם Google, טעינה ושמירה מול Firestore
  firebase-config.js הגדרות הפרויקט ב-Firebase (ציבוריות מטבען)
scripts/build.py     הופך קבצי ייצוא לקובץ נתונים אחד, data.json
firestore.rules      מי מורשה לקרוא ולכתוב את הנתונים
finance/private/     לא נכנס ל-git: קבצי ייצוא, config.json, data.json
```

**הנתונים לא נמצאים בריפו.** הם שמורים ב-Firestore, במסמכים `finance/data` (התנועות) ו-`finance/state` (תקציב ותשובות). לפי `firestore.rules`, רק הבעלים ומי שהוא שיתף איתם יכולים לקרוא או לכתוב אותם. הריפו ציבורי, ולכן אין להכניס אליו את `finance/private/`. התיקייה מוחרגת ב-`.gitignore`.

## עדכון חודשי

1. מורידים קבצי ייצוא ושמים אותם ב-`finance/private/raw/`. אין צורך למחוק קבצים ישנים: כפילויות מזוהות ונספרות פעם אחת.
   - **הבנק**: תנועות עו״ש (`.xls`)
   - **מקס**: עסקאות של כל הכרטיסים (`.xlsx`)
   - **bit**: היסטוריה (`.csv`)
   - **תלושי פנסיה**: PDF
2. מריצים:
   ```
   python scripts/build.py
   ```
   (בפעם הראשונה: `pip install xlrd openpyxl pdfplumber`)
3. נכנסים לאתר, לוחצים **״עדכון נתונים״** ובוחרים את `finance/private/data.json`.

## הגדרות (`finance/private/config.json`)

- `categories`: קטגוריות, הסוג של כל אחת ותקציב מומלץ. `income` / `expense` נספרות במאזן החודשי. `*_oneoff` (חד-פעמי) ו-`pass` (כסף שרק עובר דרככם) מוצגות בנפרד.
- `bank_rules` ו-`card_rules`: כללי סיווג (ביטוי רגולרי על תיאור התנועה). הכלל הראשון שמתאים קובע. `@card` מסמן את החיוב הכולל של כרטיס האשראי בבנק, שמוחלף בפירוט העסקאות מקובץ הכרטיס.
- `forecast`: סכומים קבועים לתחזית של חודש רגיל.
- `fixed_commitments`, `insights`, `learned`, `questions`: הטקסטים שבלשוניות.

אחרי שינוי בהגדרות מריצים שוב את `build.py` ומעלים את הקובץ החדש.

## הרשאות ופריסה

- **שיתוף:** הבעלים (המייל שמוגדר ב-`firestore.rules` וב-`docs/firebase-config.js`) לוחץ באפליקציה על **״שיתוף״** ומוסיף או מסיר כתובות Gmail. הרשימה נשמרת ב-Firestore, באוסף `access`, ולא בריפו הציבורי. מי שברשימה מתחבר עם Google ורואה ועורך את כל הנתונים.
- **פריסת חוקי האבטחה** אחרי שינוי ב-`firestore.rules`:
  ```
  npx firebase-tools deploy --only firestore:rules
  ```
- **פריסת האפליקציה** אחרי שינוי בקוד:
  ```
  npx firebase-tools deploy --only hosting
  ```
- **הגדרה חד-פעמית:** ב-Firebase Console, בתפריט Authentication ← Sign-in method, מפעילים את Google. ב-Authentication ← Settings ← Authorized domains מוסיפים את `gavishori.github.io`.
