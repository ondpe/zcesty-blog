Sbírka travel blogů z cest.

## Psaní na cestách

Web je statický Eleventy blog. Články jsou Markdown soubory ve složce `posts`
a administrace běží přes Decap CMS na `/admin/`.

### Fotky v editoru

Při psaní článku v `/admin/` použij v poli Obsah tlačítko `Vybrat fotky`.

1. Vyber fotky z Apple Photos nebo ze souborů.
2. Editor je zmenší na delší stranu 1920 px a uloží jako JPG kvalita 85.
3. Fotky vloží do článku jako markdown obrázky, seřazené podle data pořízení.
4. Stáhni připravené JPG soubory a nahraj je v CMS do složky `images`.

Řazení podle data pořízení funguje u JPEGů přes EXIF. U ostatních formátů editor
použije datum souboru. Fotky se nikam neposílají, jen se lokálně zmenší v
prohlížeči.

Samostatný nástroj `/admin/photo-prep.html` zůstává jako záložní varianta pro
hromadnou přípravu fotek mimo rozepsaný článek.

### Editor článku

CMS je záměrně nastavené jednoduše: nadpisy H1-H3, odstavce, odkazy, kurzíva
a obrázky. Složitější sazbu je lepší případně doladit až doma v Markdownu.
