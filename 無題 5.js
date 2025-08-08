// /****************************************************
//  *  Google Apps Script  –  VRP Scheduler 2025‑09
//  *  最低訪問件数フィルタ + 動的人数調整 版
//  ****************************************************/

// /*******************************
//  * 対象とする年月 (1～末日まで)
//  *******************************/
// const TARGET_YEAR  = 2025;
// const TARGET_MONTH = 9;

// /*******************************
//  * 1人あたり最低訪問件数 ★要件追加
//  *******************************/
// const MIN_VISITS_PER_EMPLOYEE = 4;   // ここを変更するだけで運用可

// /*******************************
//  * 社員ごとの稼働時間(6:00基準)
//  *******************************/
// const EMPLOYEE_TIME_RANGES = {
//   "社員A": { start: 0, end: 780 },
//   "社員B": { start: 0, end: 900 },
//   "社員C": { start: 0, end: 780 },
//   "社員D": { start: 0, end: 900 },
//   "社員E": { start: 0, end: 780 }
// };

// /********************************
//  * 移動時間バッファ
//  ********************************/
// const BUFFER_UNDER_5  = 5;
// const BUFFER_5_TO_30  = 10;
// const BUFFER_30_TO_59 = 10;
// const BUFFER_60_OVER  = 10;

// /********************************
//  * 優先順位→ペナルティ
//  ********************************/
// const PRIORITY_PENALTY_MAP = { 1: 999999, 2: 80000, 3: 50000, 4: 40000, 5: 2000 };

// /********************************
//  * （旧）固定間隔定数  ※互換用に残置
//  ********************************/
// const VISIT_INTERVAL_4_OR_MORE = 5;
// const VISIT_INTERVAL_3         = 6;
// const VISIT_INTERVAL_2         = 7;

// /********************************
//  * 社員定義
//  ********************************/
// const allEmployees                      = ["社員A", "社員B", "社員C", "社員D"];
// const vehicleCosts                      = [0, 100, 1000, 1000, 0];
// const employeesFor2Person               = ["社員D"];
// const employeesFor1PersonIf2PersonExists= ["社員A", "社員B", "社員C"];
// const employeesFor1PersonIfNo2PersonExists = ["社員A", "社員B", "社員C", "社員D"];

// /* ======================================================================
//  *                               MAIN
//  * ====================================================================*/
// function callOrtoolsFunction() {
//   Logger.log("=== callOrtoolsFunction 開始 ===");

//   /* 必須プロパティ */
//   const props   = PropertiesService.getScriptProperties();
//   const API_KEY = props.getProperty("apiKey");
//   const SSID    = props.getProperty("SPREADSHEET_ID");
//   const SSID2   = props.getProperty("SPREADSHEET_ID_2");
//   if (!API_KEY || !SSID || !SSID2) {
//     Logger.log("Missing properties → 終了");
//     return;
//   }
//   const CF_URL = "https://tagdata.synology.me";

//   /* Step‑1 : クライアント読込 */
//   const allClients = readRealClientData_(SSID2, "訪問予定調整");
//   if (!allClients.length) { Logger.log("No clients"); return; }

//   /* Step‑2 : 営業日リスト + intervalDays */
//   const dayList    = makeDateList_2025_04_01_04_30_skipWeekend();
//   const totBusDays = dayList.length;

//   allClients.sort((a, b) => a.priority === b.priority ? a.id.localeCompare(b.id)
//                                                        : a.priority - b.priority);
//   allClients.forEach(c => {
//     c.intervalDays    = Math.ceil(totBusDays / c.originalVisitsNeeded);
//     c.nextEarliestDay = 0;
//   });

//   /* Step‑3 : 各営業日ループ */
//   const finalData = [];

//   const pushSolution = (dk, sols) => {
//     const rec = finalData.find(r => r.day_key === dk);
//     if (rec) rec.solution = rec.solution.concat(sols);
//     else     finalData.push({ day_key: dk, solution: sols });
//   };

//   for (let di = 0; di < dayList.length; di++) {
//     const dayKey = dayList[di];
//     const dow    = calcUserDow(dayKey);

//     /* 候補抽出 */
//     const pool = allClients.filter(c =>
//         c.visits_needed > 0 &&
//         c.nextEarliestDay <= di &&
//         parseVisitSummary_(c.visitSummary).hasOwnProperty(String(dow)));

//     if (!pool.length) continue;

//     /* 2人対応 */
//     const twoSet = pool.filter(c => c.peopleCount === 2);
//     if (twoSet.length) {
//       const sol = solveIterativelyForTheDay_(
//         twoSet, employeesFor2Person, dayKey, di, CF_URL, API_KEY, true
//       );
//       if (sol.length) pushSolution(dayKey, sol);
//     }

//     /* 1人対応 */
//     const oneSet = pool.filter(c => c.peopleCount === 1);
//     if (oneSet.length) {
//       const emp1 = twoSet.length ? employeesFor1PersonIf2PersonExists
//                                  : employeesFor1PersonIfNo2PersonExists;
//       const sol = solveIterativelyForTheDay_(
//         oneSet, emp1, dayKey, di, CF_URL, API_KEY, false
//       );
//       if (sol.length) pushSolution(dayKey, sol);
//     }
//   }

//   /* 出力処理 */
//   adjustDepartureTimesForFirstStop_(finalData);
//   writeRouteSheet_(finalData, SSID);
//   PropertiesService.getScriptProperties()
//     .setProperty("LAST_ROUTE_DATA", JSON.stringify(finalData));

//   Logger.log("=== callOrtoolsFunction 完了 ===");
// }

// /* ======================================================================
//  * solveIterativelyForTheDay_  ★最低訪問件数ロジック実装
//  * ====================================================================*/
// function solveIterativelyForTheDay_(
//   subsetTasks, employeesAll, dayKey, di, CF_URL, API_KEY, isTwoPerson
// ) {
//   const finalSolutions = [];
//   let   taskPool = subsetTasks.slice();
//   let   empPool  = employeesAll.slice();

//   while (taskPool.filter(t => t.visits_needed > 0).length && empPool.length) {

//     const needEmpMin = Math.ceil(taskPool.length / MIN_VISITS_PER_EMPLOYEE) || 1;

//     let roundSolved = false;

//     /* 多い→少ない人数で試行。ただし上限 = needEmpMin */
//     for (let tryCount = Math.min(empPool.length, needEmpMin); tryCount >= 1; tryCount--) {

//       const emps = empPool.slice(0, tryCount);
//       const res  = runOrToolsOneShot_(dayKey, taskPool, emps, CF_URL, API_KEY, isTwoPerson);

//       if (!(res && res.status === "ok") || !res.solution.length) continue;

//       /* ▼ 最低件数フィルタ ▼ */
//       const allowSmallDay = taskPool.length < MIN_VISITS_PER_EMPLOYEE;
//       const accepted = res.solution.filter(sol => {
//         const v = sol.route.filter(r =>
//           r.location_name !== "出発拠点" && r.location_name !== "到着拠点"
//         ).length;
//         return allowSmallDay ? v > 0 : v >= MIN_VISITS_PER_EMPLOYEE;
//       });
//       if (!accepted.length) {
//         Logger.log(`[skip] ${dayKey} 社員=${tryCount} → 件数不足`);
//         continue;                // 別 tryCount へ
//       }
//       /* ▲ フィルタ終 ▲ */

//       /* 採用 → visits_needed 更新 */
//       accepted.forEach(sol => {
//         sol.route.forEach(node => {
//           if (node.location_name === "出発拠点" || node.location_name === "到着拠点") return;
//           const cl = taskPool.find(c => c.name === node.location_name);
//           if (!cl) return;
//           cl.visits_needed--;
//           if (cl.visits_needed > 0) cl.nextEarliestDay = di + cl.intervalDays;
//         });
//         finalSolutions.push(sol);
//       });

//       /* プールから消去 */
//       taskPool = taskPool.filter(t => t.visits_needed > 0 && t.nextEarliestDay <= di);
//       const used = new Set(accepted.map(s => s.employee));
//       empPool    = empPool.filter(e => !used.has(e));

//       roundSolved = true;
//       break;          // while 再評価へ
//     }

//     if (!roundSolved) break;     // これ以上解なし
//   }

//   return finalSolutions;
// }

// /* ======================================================================
//  * runOrToolsOneShot_ 以降は **元コードと同一** です。
//  * ※必要に応じてここから先はご提供済みのオリジナルをそのまま
//  *   末尾までコピーしてください（省略すると動きません）
//  * ====================================================================*/

// /* -------------- 以下、抜粋せずフルで貼り付けてください ------------------
//    buildDistMatrixWithCache_(), applyTravelTimeBuffer_(), parseVisitSummary_()
//    writeRouteSheet_() など、前回までの全関数
// --------------------------------------------------------------------------*/
