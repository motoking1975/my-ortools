# filename: main.py
import functions_framework
from flask import jsonify, Request
import math
from datetime import datetime
from ortools.constraint_solver import routing_enums_pb2, pywrapcp

@functions_framework.http
def ortools_handler(request: Request):
    """
    OR-Tools VRP Handler.
    - dist_matrix をGAS側から直接受け取り、それを利用 (キャッシュ済み)
    - 'scheduleWindows' で曜日別の訪問可能時間を適用
    - depot_lat, depot_lng などもリクエストから受け取る
    - 解が存在しない場合(infeasible)は status="infeasible" を返す
    - 訪問されなかったクライアントは "infeasible_clients" に含めて返す

    ★ 昼休憩(60分)を 11:00～15:00 の間に必ず取る機能を追加。
      enable_lunch_break=true のときに休憩が適用される。

    ★ 今回の修正点
      「退店時刻」も時間窓内に収めるために、endMin から滞在時間を引いた値を
      OR-Tools が「到着時刻の最大値」として扱うように設定する。
    """

    data = request.get_json(silent=True) or {}
    print("=== Received payload (python) ===")
    print(data)

    # ★追加: 社員ごとの開始～終了時刻(6:00=0分基準)を受け取る
    employee_time_windows = data.get("employee_time_windows", [])
    print("employee_time_windows=", employee_time_windows)

    employees = data.get("employees", [])
    clients   = data.get("clients", [])
    day_key   = data.get("day_key","2025-04-01")
    dist_matrix = data.get("dist_matrix")  # 2次元配列

    if not dist_matrix:
        print("No dist_matrix => infeasible")
        return jsonify({"status":"infeasible","day_key":day_key}), 200

    # 例: 6:00スタートで最大900分 ⇒ 21:00終了
    workday_length = int(data.get("workday_length", 900))

    # デポ座標(表示用のみ)
    depot_lat = float(data.get("depot_lat", 35.7501747))
    depot_lng = float(data.get("depot_lng", 139.7129978))

    # その日の曜日を計算 (Python: Monday=0,...Sunday=6) => ユーザ定義: 1=日,2=月,...7=土
    dt_obj = datetime.strptime(day_key, "%Y-%m-%d")
    pyDOW = dt_obj.weekday()   # 月曜=0, 火曜=1, …, 日曜=6
    map_dow = {
      6: 1,  # Sunday=6 => userDOW=1
      0: 2,  # Monday=0 => userDOW=2
      1: 3,  # Tuesday=1 => userDOW=3
      2: 4,  # Wednesday=2 => userDOW=4
      3: 5,  # Thursday=3 => userDOW=5
      4: 6,  # Friday=4 => userDOW=6
      5: 7,  # Saturday=5 => userDOW=7
    }
    userDOW = map_dow.get(pyDOW, 7) # fallback=7

    # その他パラメータ
    vehicle_costs       = data.get("vehicle_costs", [])
    max_vehicle_capacity= data.get("max_vehicle_capacity", 6)
    use_disjunction     = data.get("use_disjunction", True)
    if isinstance(use_disjunction, str):
        use_disjunction = (use_disjunction.lower()=="true")
    penalty_cost        = int(data.get("penalty_cost",10000))
    time_limit_seconds  = int(data.get("time_limit_seconds",60))

    fss_str = data.get("first_solution_strategy","AUTOMATIC").upper()
    lsm_str = data.get("local_search_metaheuristic","AUTOMATIC").upper()

    # ★追加: 優先順位→ペナルティコスト対応マップ
    priority_penalty_map = data.get("priority_penalty_map", {
        1: 30000,
        2: 30000,
        3: 30000,
        4: 30000,
        5: 30000
    })

    # 元の行列サイズ、車両数などログ表示
    N = len(dist_matrix)  # 0番がデポ、1～(N-1)がクライアント
    V = len(employees)    # 車両数

    print(f"dist_matrix size={N}x{N}, vehicles={V}, day_key={day_key}, userDOW={userDOW}")
    print(f"workday_length={workday_length}, use_disjunction={use_disjunction}, "
          f"penalty_cost={penalty_cost}, time_limit={time_limit_seconds}s")
    print(f"first_solution_strategy={fss_str}, local_search_metaheuristic={lsm_str}")
    print(f"vehicle_costs={vehicle_costs}, max_vehicle_capacity={max_vehicle_capacity}")
    print(f"priority_penalty_map={priority_penalty_map}")

    # クライアント情報ログ
    print("=== Clients info ===")
    for i, c in enumerate(clients, start=1):
        cname = c.get("name","(noName)")
        stay  = c.get("stay_min",30)
        addr  = c.get("address","(noAddr)")
        swins = c.get("scheduleWindows",{})
        # ★追加: 優先順位をログに出す
        prior = c.get("priority", "")
        print(f" Client #{i}: name={cname}, stay_min={stay}, priority={prior}, address={addr}, scheduleWindows={swins}")

    # OR-ToolsのIndexManager (depots=0, starts=0, ends=0)
    manager = pywrapcp.RoutingIndexManager(N, V, [0]*V, [0]*V)
    routing = pywrapcp.RoutingModel(manager)

    # 距離コールバック
    def dist_cb(from_i, to_i):
        f = manager.IndexToNode(from_i)
        t = manager.IndexToNode(to_i)
        return dist_matrix[f][t]
    dist_cb_id = routing.RegisterTransitCallback(dist_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(dist_cb_id)

    # サービス時間(滞在)
    service_times = [0]*N
    for i, c in enumerate(clients, start=1):
        st = c.get("stay_min", 30)
        service_times[i] = st

    # 移動 + サービス時間コールバック
    def time_cb(from_i, to_i):
        f = manager.IndexToNode(from_i)
        return dist_matrix[f][manager.IndexToNode(to_i)] + service_times[f]
    time_cb_id = routing.RegisterTransitCallback(time_cb)

    # ★修正: startCumulToZero => False (社員によって柔軟に設定)
    routing.AddDimension(
        time_cb_id,
        999999,              # allowed waiting slack
        workday_length,      # 1日の稼働上限 (6:00=0分 基準で最大900分)
        False,               # Falseにすることで開始時刻を固定しない
        "TimeDim"
    )
    tdim = routing.GetDimensionOrDie("TimeDim")

    # クライアントのTime Window設定
    print("=== Setting up Time Windows for clients ===")
    for i, c in enumerate(clients, start=1):
        node_index = manager.NodeToIndex(i)

        # 優先順位 → ペナルティコスト
        priority_str = str(c.get("priority","")).strip()
        if priority_str == "":
            priority_val = 5
        else:
            try:
                priority_val = int(priority_str)
            except:
                priority_val = 5
        client_penalty = priority_penalty_map.get(priority_val, priority_penalty_map.get(5, 30000))

        if use_disjunction:
            routing.AddDisjunction([node_index], client_penalty)

        sched_map = c.get("scheduleWindows", {})
        if str(userDOW) not in sched_map:
            # スケジュールになければ不訪問扱い(ペナルティ)
            if use_disjunction:
                print(f"  Client#{i}: no window for day={userDOW}, AddDisjunction(penalty={client_penalty})")
            else:
                print(f"  Client#{i}: no window for day={userDOW}, forcibly infeasible")
                tdim.CumulVar(node_index).SetRange(workday_length*2, workday_length*2)
            continue

        startMin, endMin = sched_map[str(userDOW)]
        print(f"  Client#{i}, day={userDOW}, raw=({startMin}-{endMin})")

        if startMin < 0:
            startMin = 0
        if endMin > workday_length:
            endMin = workday_length

        # ### 修正: endMin から滞在時間を差し引いて、退店時刻が endMin を超えないようにする
        stay_t = service_times[i]  # そのクライアントの滞在時間
        adjusted_end = endMin - stay_t
        print(f"    => (退店時刻制約) endMin={endMin}, stay_t={stay_t} => adjusted_end={adjusted_end}")

        if adjusted_end < startMin:
            # 到着猶予が無い場合 => 不訪問(Penalty)または強制 infeasible にする
            if use_disjunction:
                print(f"    => invalid window => AddDisjunction(penalty={client_penalty})")
            else:
                print(f"    => invalid window => forcibly infeasible")
                tdim.CumulVar(node_index).SetRange(workday_length*2, workday_length*2)
            continue

        # ### 退店時刻が endMin 以内になるように、到着時刻の上限を adjusted_end に設定
        tdim.CumulVar(node_index).SetRange(startMin, adjusted_end)
        print(f"    => final window set: {startMin}-{adjusted_end} (サービス完了で～{endMin})")

    # デポ(0) の時間窓 (0～workday_length)
    print(f"Setting depot (node 0) time window => 0-{workday_length}")

    # 各車両(=社員)の開始時刻・終了時刻をセット (6:00=0分 基準)
    print("=== Setting start/end range for each vehicle based on employee_time_windows ===")
    for v_i in range(V):
        # デフォルトは 0～workday_length
        tw = {"start": 0, "end": workday_length}
        if v_i < len(employee_time_windows):
            tw = employee_time_windows[v_i]

        start_val = tw.get("start", 0)
        end_val   = tw.get("end", workday_length)

        sIdx = routing.Start(v_i)
        sVar = tdim.CumulVar(sIdx)
        sVar.SetRange(start_val, start_val)

        eIdx = routing.End(v_i)
        eVar = tdim.CumulVar(eIdx)
        eVar.SetRange(start_val, end_val)

        empName = employees[v_i] if v_i < len(employees) else f"Vehicle{v_i}"
        print(f"  Vehicle#{v_i} => employee={empName}, start={start_val}, end={end_val}")

    # 容量(訪問上限)
    demands = [0]*N
    for nd in range(1, N):
        demands[nd] = 1

    def dmd_cb(idx):
        return demands[manager.IndexToNode(idx)]
    dmd_cb_id = routing.RegisterUnaryTransitCallback(dmd_cb)
    routing.AddDimensionWithVehicleCapacity(
        dmd_cb_id,
        0,
        [max_vehicle_capacity]*V,
        True,
        "CountDim"
    )

    # 車両固定コスト
    if len(vehicle_costs) != V:
        vehicle_costs = [1000]*V
    for v_i in range(V):
        routing.SetFixedCostOfVehicle(vehicle_costs[v_i], v_i)
        print(f"  vehicle#{v_i} => fixed cost={vehicle_costs[v_i]}")

    # FirstSolutionStrategy
    fss_map = {
        "AUTOMATIC": routing_enums_pb2.FirstSolutionStrategy.AUTOMATIC,
        "PATH_CHEAPEST_ARC": routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC,
        "PARALLEL_CHEAPEST_INSERTION": routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION,
        "SAVINGS": routing_enums_pb2.FirstSolutionStrategy.SAVINGS,
        "SWEEP": routing_enums_pb2.FirstSolutionStrategy.SWEEP,
        "CHRISTOFIDES": routing_enums_pb2.FirstSolutionStrategy.CHRISTOFIDES,
        "ALL_UNPERFORMED": routing_enums_pb2.FirstSolutionStrategy.ALL_UNPERFORMED,
    }
    fss_val = fss_map.get(fss_str, routing_enums_pb2.FirstSolutionStrategy.AUTOMATIC)

    # LocalSearchMetaheuristic
    lsm_map = {
        "AUTOMATIC": routing_enums_pb2.LocalSearchMetaheuristic.AUTOMATIC,
        "GUIDED_LOCAL_SEARCH": routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH,
        "SIMULATED_ANNEALING": routing_enums_pb2.LocalSearchMetaheuristic.SIMULATED_ANNEALING,
        "TABU_SEARCH": routing_enums_pb2.LocalSearchMetaheuristic.TABU_SEARCH,
    }
    lsm_val = lsm_map.get(lsm_str, routing_enums_pb2.LocalSearchMetaheuristic.AUTOMATIC)

    # === 昼休憩を設定（enable_lunch_break が true の場合） ===
    if data.get("enable_lunch_break", True):
        print("=== Setting LUNCH BREAK intervals (60min, 11:00～15:00) ===")
        solver = routing.solver()
        # 6:00=0分基準 => 11:00=300, 15:00=540
        # 休憩は1時間なので、開始は 300～480 の範囲内
        for v_i in range(V):
            break_var = solver.FixedDurationIntervalVar(
                300,   # earliest start (11:00)
                510,   # latest start (14:00) => 14:00+60=15:30に休憩終了
                60,    # duration (60分)
                False, # 必須休憩
                f"LunchBreak_{v_i}"
            )
            tdim.SetBreakIntervalsOfVehicle([break_var], v_i, service_times)

    # Solve
    sp = pywrapcp.DefaultRoutingSearchParameters()
    sp.time_limit.seconds = time_limit_seconds
    sp.log_search = True
    sp.first_solution_strategy = fss_val
    sp.local_search_metaheuristic = lsm_val

    print("=== Start Solve ===")
    import time
    start_ts = time.time()
    solution = routing.SolveWithParameters(sp)
    elapsed = time.time() - start_ts
    print(f"=== Solve完了（所要時間: {elapsed:.2f} 秒） ===")

    # infeasibleの場合
    if not solution:
        print("No solution => infeasible")
        infeasible_list = []
        # 全クライアントを infeasible として返す
        for nd in range(1, N):
            ci = nd - 1
            c_name = clients[ci].get("name", "(noName)")
            infeasible_list.append(c_name)

        print(f"=== Solve failed, infeasible candidates: {infeasible_list} ===")
        return jsonify({
            "status": "infeasible",
            "day_key": day_key,
            "infeasible_clients": infeasible_list
        }), 200

    # 解が見つかった場合
    print("=== Solution found => extracting routes ===")
    results = []
    visited_flags = [False]*N

    # TimeDim
    tdim = routing.GetDimensionOrDie("TimeDim")

    for v_i in range(V):
        start_idx = routing.Start(v_i)
        idx = start_idx
        routeSteps = []
        prev_nd = manager.IndexToNode(idx)

        while not routing.IsEnd(idx):
            cur_nd = manager.IndexToNode(idx)
            arrVal = solution.Value(tdim.CumulVar(idx))

            base = 6*60 + arrVal
            hh = base // 60
            mm = base % 60
            tStr = f"{hh:02d}:{mm:02d}"

            if cur_nd == 0:
                # 出発拠点
                locName = "出発拠点"
                laN, lnN = depot_lat, depot_lng
                stM = 0
            else:
                # 通常クライアント
                visited_flags[cur_nd] = True
                ci = cur_nd - 1
                cdat = clients[ci]
                locName = cdat.get("name", f"client{ci+1}")
                try:
                    laS, lnS = cdat["address"].split(",")
                    laN, lnN = float(laS), float(lnS)
                except:
                    laN, lnN = (35.75, 139.60)
                stM = service_times[cur_nd]

            trav = dist_matrix[prev_nd][cur_nd]
            routeSteps.append({
                "location_name": locName,
                "time": tStr,
                "travel_minutes": trav,
                "lat": laN,
                "lng": lnN,
                "stay_min": stM,
                "nd": cur_nd
            })

            prev_nd = cur_nd
            idx = solution.Value(routing.NextVar(idx))

        # ルート終端（到着拠点）
        end_nd = manager.IndexToNode(idx)
        arr2 = solution.Value(tdim.CumulVar(idx))
        base2 = 6*60 + arr2
        hh2 = base2 // 60
        mm2 = base2 % 60
        trav2 = dist_matrix[prev_nd][end_nd]

        routeSteps.append({
            "location_name": "到着拠点",
            "time": f"{hh2:02d}:{mm2:02d}",
            "travel_minutes": trav2,
            "lat": depot_lat,
            "lng": depot_lng,
            "stay_min": 0,
            "nd": end_nd
        })

        # 昼休憩(ブレイク)情報の取得
        vehicle_breaks = []
        try:
            break_intervals = tdim.VehicleBreakIntervalsOfVehicle(v_i)
            for b_intv in break_intervals:
                start_b = solution.Value(b_intv.StartExpr())
                end_b   = solution.Value(b_intv.EndExpr())
                vehicle_breaks.append({
                    "start": start_b,
                    "end": end_b,
                    "duration": end_b - start_b
                })
        except AttributeError:
            # もし古いバージョンの OR-Tools で動かす場合は無視
            pass

        # 「1件も客先を訪問しない車」は出動扱いにしない
        real_visit_count = sum(
            1
            for st in routeSteps
            if st["location_name"] not in ("出発拠点", "到着拠点")
        )
        if real_visit_count > 0:
            results.append({
                "employee": employees[v_i],
                "route": routeSteps,
                "breaks": vehicle_breaks
            })
            print(f"  Vehicle {v_i} => route with {real_visit_count} client visits.")
        else:
            print(f"  Vehicle {v_i} => no real client visited => skipping result output.")

    # 不訪問クライアントの抽出
    infeasible_list = []
    for nd in range(1, N):
        if not visited_flags[nd]:
            ci = nd - 1
            c_name = clients[ci].get("name","(noName)")
            infeasible_list.append(c_name)

    print(f"=== Infeasible clients => {infeasible_list} ===")

    return jsonify({
        "status": "ok",
        "day_key": day_key,
        "solution": results,
        "infeasible_clients": infeasible_list
    }), 200


# --- Docker 実行用エントリポイント ---
if __name__ == "__main__":
    from flask import Flask, request
    app = Flask(__name__)

    @app.route("/", methods=["POST"])
    def handler():
        return ortools_handler(request)

    print("=== Starting Flask on port 9999 ===")
    app.run(host="0.0.0.0", port=9999)
