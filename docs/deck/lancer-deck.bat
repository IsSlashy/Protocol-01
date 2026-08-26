@echo off
REM ============================================================================
REM  Decks Styx.  Double-clic, choisis, la page s'ouvre.
REM
REM    1  Hackathon, 3 minutes  --  7 planches presentees, 10 en annexe
REM    2  Castle DAO, long      --  11 planches, lecture longue
REM
REM  Rien a installer, aucun serveur, aucune connexion : la police Newsreader
REM  est inlinee dans les deux fichiers HTML, donc un deck rend a l'identique
REM  sur une machine hors reseau. Un <link> vers un CDN de polices serait
REM  retombe en silence sur Georgia, et la planche aurait change de voix sans
REM  que personne le voie.
REM
REM  Le chemin est resolu depuis l'emplacement de ce fichier (%~dp0), donc le
REM  dossier docs\deck peut etre deplace ou copie sur une cle sans rien casser.
REM ============================================================================

setlocal

echo.
echo   Quel deck ?
echo.
echo     1  Hackathon, 3 minutes   (7 planches + annexe, horloge sur chaque planche)
echo     2  Castle DAO, long       (11 planches)
echo.

choice /c 12 /n /m "   Tape 1 ou 2 : "

if errorlevel 2 (
    set "DECK=%~dp0castle-dao-2026-09-04.html"
    set "TITRE=Castle DAO, 4 septembre 2026  --  11 planches"
    set "NOTE=Export PDF : Ctrl+P, marges Aucune, et COCHER Graphiques d'arriere-plan."
) else (
    set "DECK=%~dp0hackathon-3min-2026-09-04.html"
    set "TITRE=Hackathon, 3 minutes  --  7 planches presentees, 10 en annexe"
    set "NOTE=Le script parle est dans three-minute-script.md, a cote."
)

if not exist "%DECK%" (
    echo.
    echo   Fichier introuvable :
    echo     %DECK%
    echo.
    echo   Ce .bat doit rester a cote des fichiers HTML. Si tu l'as deplace seul,
    echo   remets-le dans docs\deck\ ou copie le dossier entier.
    echo.
    pause
    exit /b 1
)

echo.
echo   Ouverture  --  %TITRE%
echo   %NOTE%
echo.

REM `start ""` : le premier argument vide est le TITRE de la fenetre, pas le
REM fichier. Sans lui, cmd prend le chemin pour un titre et n'ouvre rien des
REM que le chemin contient un espace.
start "" "%DECK%"

endlocal
