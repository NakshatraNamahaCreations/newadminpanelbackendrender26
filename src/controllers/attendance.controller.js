import mongoose     from "mongoose";
import PDFDocument from "pdfkit";
import Employee    from "../models/Employee.js";
import Attendance  from "../models/Attendance.js";
import SalaryRecord from "../models/SalaryRecord.js";

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Returns true if the given string is a valid MongoDB ObjectId.
 */
function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the number of working days (Mon-Sat) in a given month/year.
 */
export function getWorkingDaysInMonth(month, year) {
  const daysInMonth = new Date(year, month, 0).getDate(); // month is 1-based
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month - 1, d).getDay(); // 0=Sun
    if (day !== 0) count++; // exclude Sunday only (Mon-Sat = 1-6)
  }
  return count;
}

/**
 * Parses "HH:MM" and returns a Date object on the same day as `baseDate`
 * (UTC midnight) with that local time assumed as UTC for simplicity.
 * @param {string} hhmm - "HH:MM"
 * @param {Date}   baseDate - the attendance date (UTC midnight)
 * @returns {Date}
 */
function buildShiftDateTime(hhmm, baseDate) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(baseDate);
  d.setUTCHours(hh, mm, 0, 0);
  return d;
}

/**
 * Computes derived attendance fields given check-in/out times and employee shift config.
 */
export function computeAttendanceStatus(checkIn, checkOut, employee, date) {
  if (!checkIn) {
    return { status: "absent", lateMinutes: 0, earlyLeaveMin: 0, workingHours: 0 };
  }

  const shiftStartDt = buildShiftDateTime(employee.shiftStart || "09:30", date);
  const shiftEndDt   = buildShiftDateTime(employee.shiftEnd   || "18:30", date);
  const grace        = employee.gracePeriodMin != null ? employee.gracePeriodMin : 15;

  // Late minutes: how many minutes after (shiftStart + grace) the employee checked in
  const lateMs      = checkIn - shiftStartDt - grace * 60 * 1000;
  const lateMinutes = Math.max(0, Math.round(lateMs / 60000));

  // Early leave: how many minutes before shiftEnd the employee checked out
  let earlyLeaveMin = 0;
  if (checkOut) {
    const earlyMs = shiftEndDt - checkOut;
    earlyLeaveMin = Math.max(0, Math.round(earlyMs / 60000));
  }

  // Working hours (clamp to 0 in case checkOut < checkIn due to data entry error)
  const workingHours = checkOut ? Math.max(0, (checkOut - checkIn) / 3_600_000) : 0;

  // Determine status
  let status;
  if (workingHours >= 4 && lateMinutes > 0) {
    status = "late";
  } else if (workingHours >= 4) {
    status = "present";
  } else if (workingHours > 0 && workingHours < 4) {
    status = "half-day";
  } else {
    status = "absent";
  }

  return {
    status,
    lateMinutes,
    earlyLeaveMin,
    workingHours: Math.round(workingHours * 100) / 100,
  };
}

/**
 * Normalise a date string / Date object to UTC midnight.
 */
function toUTCMidnight(dateInput) {
  const d = new Date(dateInput);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Builds a full Date for a check-in/out time string "HH:MM" on the given date.
 * If already a valid Date / ISO string, just wraps it.
 */
function buildCheckDateTime(timeInput, dateUtcMidnight) {
  if (!timeInput) return null;
  // If it looks like "HH:MM" or "H:MM"
  if (typeof timeInput === "string" && /^\d{1,2}:\d{2}$/.test(timeInput.trim())) {
    return buildShiftDateTime(timeInput.trim(), dateUtcMidnight);
  }
  // Otherwise treat as full datetime string / timestamp
  const d = new Date(timeInput);
  return isNaN(d) ? null : d;
}

// ---------------------------------------------------------------------------
// Employee CRUD
// ---------------------------------------------------------------------------

export async function getEmployees(req, res) {
  try {
    const { branch, isActive, q } = req.query;
    const filter = {};
    if (branch) filter.branch = branch;
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (q && q.trim()) {
      const regex = new RegExp(escapeRegex(q.trim()), "i");
      filter.$or = [
        { name:       regex },
        { employeeId: regex },
        { email:      regex },
        { phone:      regex },
      ];
    }
    const employees = await Employee.find(filter).sort({ employeeId: 1 }).lean();
    return res.json({ success: true, data: employees });
  } catch (err) {
    console.error("getEmployees error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function getEmployeeById(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid employee ID format" });
    }
    const emp = await Employee.findById(req.params.id).lean();
    if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });
    return res.json({ success: true, data: emp });
  } catch (err) {
    console.error("getEmployeeById error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function createEmployee(req, res) {
  try {
    const { employeeId, name, branch } = req.body;
    if (!employeeId || !String(employeeId).trim()) {
      return res.status(400).json({ success: false, message: "employeeId is required" });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "name is required" });
    }
    if (!branch) {
      return res.status(400).json({ success: false, message: "branch is required" });
    }

    // Uniqueness check (the unique index will also enforce this, but give a clear message)
    const existing = await Employee.findOne({ employeeId: String(employeeId).trim() });
    if (existing) {
      return res.status(400).json({ success: false, message: `Employee ID "${employeeId}" already exists` });
    }

    const body = { ...req.body };
    // Auto-create starting salary history entry
    if (body.monthlySalary && Number(body.monthlySalary) > 0 && (!body.salaryHistory || body.salaryHistory.length === 0)) {
      body.salaryHistory = [{ salary: Number(body.monthlySalary), effectiveDate: body.joinedDate ? new Date(body.joinedDate) : new Date(), hikePct: null, remarks: "Starting salary" }];
    }
    const emp = await Employee.create(body);
    return res.status(201).json({ success: true, data: emp });
  } catch (err) {
    console.error("createEmployee error:", err);
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: "Employee ID already exists" });
    }
    if (err.name === "ValidationError") {
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function updateEmployee(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid employee ID format" });
    }
    const emp = await Employee.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });
    return res.json({ success: true, data: emp });
  } catch (err) {
    console.error("updateEmployee error:", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function addSalaryHike(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid employee ID format" });
    }
    const { salary, effectiveDate, hikePct, remarks } = req.body;
    if (!salary || !effectiveDate) {
      return res.status(400).json({ success: false, message: "salary and effectiveDate are required" });
    }
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });

    // Auto-calculate hike % if not provided
    let pct = hikePct != null ? Number(hikePct) : null;
    if (pct == null && emp.monthlySalary > 0) {
      pct = Math.round(((Number(salary) - emp.monthlySalary) / emp.monthlySalary) * 10000) / 100;
    }

    emp.salaryHistory.push({ salary: Number(salary), effectiveDate: new Date(effectiveDate), hikePct: pct, remarks: remarks || "" });
    emp.monthlySalary = Number(salary);
    await emp.save();
    return res.json({ success: true, data: emp });
  } catch (err) {
    console.error("addSalaryHike error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function deleteEmployee(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid employee ID format" });
    }
    // Soft delete: set isActive = false
    const emp = await Employee.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    );
    if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });
    return res.json({ success: true, message: "Employee deactivated", data: emp });
  } catch (err) {
    console.error("deleteEmployee error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// Daily Attendance
// ---------------------------------------------------------------------------

export async function getDailyAttendance(req, res) {
  try {
    const { branch } = req.query;
    const dateStr    = req.query.date || new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const dateUTC = toUTCMidnight(dateStr);

    // Load active employees for the branch (or all if no branch)
    const empFilter = { isActive: true };
    if (branch) empFilter.branch = branch;
    const employees = await Employee.find(empFilter).sort({ employeeId: 1 }).lean();

    if (!employees.length) {
      return res.json({ success: true, data: [] });
    }

    const empIds = employees.map((e) => e._id);
    const month  = dateUTC.getUTCMonth() + 1;
    const year   = dateUTC.getUTCFullYear();

    // Load attendance records for that day
    const records = await Attendance.find({
      employeeId: { $in: empIds },
      date: dateUTC,
    }).lean();

    // Aggregate monthly working hours per employee
    const monthlyHoursAgg = await Attendance.aggregate([
      { $match: { employeeId: { $in: empIds }, month, year } },
      { $group: { _id: "$employeeId", totalHours: { $sum: "$workingHours" }, daysWorked: { $sum: { $cond: [{ $gt: ["$workingHours", 0] }, 1, 0] } } } },
    ]);
    const monthlyHoursMap = {};
    for (const a of monthlyHoursAgg) {
      monthlyHoursMap[String(a._id)] = { totalHours: Math.round(a.totalHours * 100) / 100, daysWorked: a.daysWorked };
    }

    const recordMap = {};
    for (const r of records) {
      recordMap[String(r.employeeId)] = r;
    }

    const result = employees.map((emp) => ({
      employee:     emp,
      monthlyHours: monthlyHoursMap[String(emp._id)] || { totalHours: 0, daysWorked: 0 },
      attendance: recordMap[String(emp._id)] || {
        employeeId:    emp._id,
        employeeName:  emp.name,
        employeeCode:  emp.employeeId,
        branch:        emp.branch,
        date:          dateUTC,
        month:         dateUTC.getUTCMonth() + 1,
        year:          dateUTC.getUTCFullYear(),
        status:        "absent",
        checkIn:       null,
        checkOut:      null,
        workingHours:  0,
        lateMinutes:   0,
        earlyLeaveMin: 0,
      },
    }));

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("getDailyAttendance error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function markAttendance(req, res) {
  try {
    const {
      employeeId,
      date,
      checkIn:   checkInRaw,
      checkOut:  checkOutRaw,
      status:    statusOverride,
      leaveType,
      notes,
      markedBy,
    } = req.body;

    if (!employeeId) {
      return res.status(400).json({ success: false, message: "employeeId is required" });
    }
    if (!isValidObjectId(employeeId)) {
      return res.status(400).json({ success: false, message: "Invalid employeeId format" });
    }
    if (!date) {
      return res.status(400).json({ success: false, message: "date is required" });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const dateUTC  = toUTCMidnight(date);
    if (isNaN(dateUTC.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid date value" });
    }
    const checkIn  = buildCheckDateTime(checkInRaw,  dateUTC);
    const checkOut = buildCheckDateTime(checkOutRaw, dateUTC);

    // Compute derived fields (workingHours, lateMinutes, etc.)
    let computed = computeAttendanceStatus(checkIn, checkOut, employee, dateUTC);

    // Always honour an explicit status override from the UI
    if (statusOverride) {
      computed.status = statusOverride;
      // For non-auto statuses (absent/leave/holiday), zero out time-derived fields
      if (["absent", "leave", "holiday"].includes(statusOverride)) {
        computed.lateMinutes   = 0;
        computed.earlyLeaveMin = 0;
        computed.workingHours  = 0;
      }
    }

    const payload = {
      employeeId:    employee._id,
      employeeName:  employee.name,
      employeeCode:  employee.employeeId,
      branch:        employee.branch,
      date:          dateUTC,
      month:         dateUTC.getUTCMonth() + 1,
      year:          dateUTC.getUTCFullYear(),
      checkIn:       checkIn  || null,
      checkOut:      checkOut || null,
      workingHours:  computed.workingHours,
      lateMinutes:   computed.lateMinutes,
      earlyLeaveMin: computed.earlyLeaveMin,
      status:        computed.status,
      leaveType:     leaveType || "",
      notes:         notes    || "",
      markedBy:      markedBy || "",
    };

    const record = await Attendance.findOneAndUpdate(
      { employeeId: employee._id, date: dateUTC },
      payload,
      { upsert: true, new: true }
    );

    return res.json({ success: true, data: record });
  } catch (err) {
    console.error("markAttendance error:", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function bulkMarkAttendance(req, res) {
  try {
    const { records } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ success: false, message: "records array is required" });
    }

    const saved  = [];
    const errors = [];

    await Promise.all(
      records.map(async (rec, index) => {
        try {
          if (!rec.employeeId || !isValidObjectId(rec.employeeId)) {
            throw new Error(`Invalid or missing employeeId`);
          }
          if (!rec.date) {
            throw new Error(`date is required`);
          }

          const emp = await Employee.findById(rec.employeeId);
          if (!emp) throw new Error(`Employee ${rec.employeeId} not found`);

          const dateUTC = toUTCMidnight(rec.date);
          if (isNaN(dateUTC.getTime())) {
            throw new Error(`Invalid date value`);
          }

          const checkIn  = buildCheckDateTime(rec.checkIn,  dateUTC);
          const checkOut = buildCheckDateTime(rec.checkOut, dateUTC);

          let computed = computeAttendanceStatus(checkIn, checkOut, emp, dateUTC);
          if (rec.status) {
            computed.status = rec.status;
            if (["absent", "leave", "holiday"].includes(rec.status)) {
              computed.lateMinutes = 0; computed.earlyLeaveMin = 0; computed.workingHours = 0;
            }
          }

          const payload = {
            employeeId:    emp._id,
            employeeName:  emp.name,
            employeeCode:  emp.employeeId,
            branch:        emp.branch,
            date:          dateUTC,
            month:         dateUTC.getUTCMonth() + 1,
            year:          dateUTC.getUTCFullYear(),
            checkIn:       checkIn  || null,
            checkOut:      checkOut || null,
            workingHours:  computed.workingHours,
            lateMinutes:   computed.lateMinutes,
            earlyLeaveMin: computed.earlyLeaveMin,
            status:        computed.status,
            leaveType:     rec.leaveType || "",
            notes:         rec.notes    || "",
            markedBy:      rec.markedBy || "",
          };

          const result = await Attendance.findOneAndUpdate(
            { employeeId: emp._id, date: dateUTC },
            payload,
            { upsert: true, new: true }
          );
          saved.push(result);
        } catch (e) {
          errors.push({ index, error: e.message, input: rec });
        }
      })
    );

    return res.json({
      success: errors.length === 0,
      data: { saved, errors, totalProcessed: records.length, successCount: saved.length, errorCount: errors.length },
    });
  } catch (err) {
    console.error("bulkMarkAttendance error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// Monthly Report
// ---------------------------------------------------------------------------

export async function getMonthlyReport(req, res) {
  try {
    const { month, year, branch } = req.query;

    if (!month || !year) {
      return res.status(400).json({ success: false, message: "month and year are required" });
    }

    const m = Number(month);
    const y = Number(year);

    if (isNaN(m) || isNaN(y) || m < 1 || m > 12 || y < 2000 || y > 2100) {
      return res.status(400).json({ success: false, message: "Invalid month (1-12) or year" });
    }

    // Active employees
    const empFilter = { isActive: true };
    if (branch) empFilter.branch = branch;
    const employees = await Employee.find(empFilter).sort({ employeeId: 1 }).lean();

    // All attendance records for this month/year/branch
    const attFilter = { month: m, year: y };
    if (branch) attFilter.branch = branch;
    const records = await Attendance.find(attFilter).lean();

    // Build per-employee map: { [empId]: { [YYYY-MM-DD]: record } }
    const attByEmp = {};
    for (const r of records) {
      const key     = String(r.employeeId);
      const dateKey = r.date.toISOString().slice(0, 10);
      if (!attByEmp[key]) attByEmp[key] = {};
      attByEmp[key][dateKey] = r;
    }

    const result = employees.map((emp) => {
      const days = attByEmp[String(emp._id)] || {};
      const vals = Object.values(days);

      const summary = {
        present:  vals.filter((r) => r.status === "present").length,
        absent:   vals.filter((r) => r.status === "absent").length,
        late:     vals.filter((r) => r.status === "late").length,
        halfDay:  vals.filter((r) => r.status === "half-day").length,
        leave:    vals.filter((r) => r.status === "leave").length,
      };

      return { employee: emp, days, summary };
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("getMonthlyReport error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// Salary
// ---------------------------------------------------------------------------

export async function generateSalary(req, res) {
  try {
    const { employeeId, month, year, generatedBy } = req.body;

    if (!employeeId || !month || !year) {
      return res.status(400).json({ success: false, message: "employeeId, month, and year are required" });
    }
    if (!isValidObjectId(employeeId)) {
      return res.status(400).json({ success: false, message: "Invalid employeeId format" });
    }

    const m = Number(month);
    const y = Number(year);

    if (isNaN(m) || isNaN(y) || m < 1 || m > 12 || y < 2000 || y > 2100) {
      return res.status(400).json({ success: false, message: "Invalid month (1-12) or year" });
    }

    const emp = await Employee.findById(employeeId);
    if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });

    const totalWorkingDays = getWorkingDaysInMonth(m, y);

    // Aggregate attendance for this employee / month / year
    const [agg] = await Attendance.aggregate([
      { $match: { employeeId: emp._id, month: m, year: y } },
      {
        $group: {
          _id: null,
          presentDays:      { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
          lateDays:         { $sum: { $cond: [{ $eq: ["$status", "late"] },    1, 0] } },
          halfDays:         { $sum: { $cond: [{ $eq: ["$status", "half-day"] }, 1, 0] } },
          leaveDays:        { $sum: { $cond: [{ $eq: ["$status", "leave"] },   1, 0] } },
          absentDays:       { $sum: { $cond: [{ $eq: ["$status", "absent"] },  1, 0] } },
          totalLateMinutes: { $sum: "$lateMinutes" },
        },
      },
    ]);

    const presentDays      = agg?.presentDays      || 0;
    const lateDays         = agg?.lateDays         || 0;
    const halfDays         = agg?.halfDays         || 0;
    const leaveDays        = agg?.leaveDays        || 0;
    const absentDays       = agg?.absentDays       || 0;
    const totalLateMinutes = agg?.totalLateMinutes || 0;

    const grossSalary = emp.monthlySalary || 0;
    const perDayRate  = totalWorkingDays > 0 ? grossSalary / totalWorkingDays : 0;
    const daysInMonth = new Date(y, m, 0).getDate();

    // Salary component breakdown — use fixed amounts if set, else % fallback
    const basicSalary      = emp.basicAmt > 0 ? emp.basicAmt : Math.round(grossSalary * ((emp.basicPct ?? 40) / 100));
    const hra              = emp.hraAmt   > 0 ? emp.hraAmt   : Math.round(basicSalary * ((emp.hraPct   ?? 40) / 100));
    const da               = emp.daAmt    > 0 ? emp.daAmt    : Math.round(basicSalary * ((emp.daPct    ?? 10) / 100));
    const specialAllowance = Math.max(0, grossSalary - basicSalary - hra - da);

    // Attendance-based deductions
    // Probationary employees get NO free leave — all leave days deducted
    // Permanent employees get 1.5 days/month free leave
    const isProbationary    = emp.employmentType === "probationary";
    const LEAVE_ENTITLEMENT = isProbationary ? 0 : 1.5;
    const excessLeaveDays   = Math.max(0, leaveDays - LEAVE_ENTITLEMENT);
    const absentDeduction   = absentDays      * perDayRate;
    const halfDayDeduction  = halfDays        * (perDayRate / 2);
    const leaveDeduction    = excessLeaveDays * perDayRate;
    const lateDeduction     = 0;

    // Statutory deductions — respecting employee flags
    const pfEmployee     = emp.pfApplicable  !== false ? (emp.pfFixed  || 0) : 0;
    const pfEmployer     = pfEmployee;
    const esi            = emp.esiApplicable             ? (emp.esiFixed || 0) : 0;
    const professionalTax = emp.ptApplicable !== false   ? (emp.ptFixed  || 0) : 0;

    const totalDeduction = Math.round(
      (absentDeduction + halfDayDeduction + leaveDeduction + pfEmployee + esi + professionalTax) * 100
    ) / 100;
    const netSalary = Math.max(0, Math.round((grossSalary - totalDeduction) * 100) / 100);

    const record = await SalaryRecord.findOneAndUpdate(
      { employeeId: emp._id, month: m, year: y },
      {
        employeeId:    emp._id,
        employeeName:  emp.name,
        employeeCode:  emp.employeeId,
        branch:        emp.branch,
        department:    emp.department,
        designation:   emp.designation,
        month:         m,
        year:          y,
        totalWorkingDays,
        daysInMonth,
        presentDays,
        absentDays,
        lateDays,
        halfDays,
        leaveDays,
        totalLateMinutes,
        grossSalary,
        basicSalary,
        hra,
        da,
        specialAllowance,
        perDayRate:       Math.round(perDayRate * 100) / 100,
        monthlyLeaveEntitlement: LEAVE_ENTITLEMENT,
        excessLeaveDays:  Math.round(excessLeaveDays * 100) / 100,
        absentDeduction:  Math.round(absentDeduction  * 100) / 100,
        halfDayDeduction: Math.round(halfDayDeduction * 100) / 100,
        leaveDeduction:   Math.round(leaveDeduction   * 100) / 100,
        lateDeduction:    0,
        pfEmployee,
        pfEmployer,
        esi,
        professionalTax,
        totalDeduction,
        netSalary,
        generatedBy:   generatedBy || "",
        generatedAt:   new Date(),
      },
      { upsert: true, new: true }
    );

    return res.json({ success: true, data: record });
  } catch (err) {
    console.error("generateSalary error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function generateBulkSalary(req, res) {
  try {
    const { month, year, branch, generatedBy } = req.body;

    if (!month || !year) {
      return res.status(400).json({ success: false, message: "month and year are required" });
    }

    const mCheck = Number(month);
    const yCheck = Number(year);
    if (isNaN(mCheck) || isNaN(yCheck) || mCheck < 1 || mCheck > 12 || yCheck < 2000 || yCheck > 2100) {
      return res.status(400).json({ success: false, message: "Invalid month (1-12) or year" });
    }

    const empFilter = { isActive: true };
    if (branch) empFilter.branch = branch;

    const employees = await Employee.find(empFilter).lean();

    const generated = [];
    const errors    = [];

    await Promise.all(
      employees.map(async (emp) => {
        try {
          const m = Number(month);
          const y = Number(year);

          const totalWorkingDays = getWorkingDaysInMonth(m, y);

          const [agg] = await Attendance.aggregate([
            { $match: { employeeId: emp._id, month: m, year: y } },
            {
              $group: {
                _id: null,
                presentDays:      { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
                lateDays:         { $sum: { $cond: [{ $eq: ["$status", "late"] },    1, 0] } },
                halfDays:         { $sum: { $cond: [{ $eq: ["$status", "half-day"] }, 1, 0] } },
                leaveDays:        { $sum: { $cond: [{ $eq: ["$status", "leave"] },   1, 0] } },
                absentDays:       { $sum: { $cond: [{ $eq: ["$status", "absent"] },  1, 0] } },
                totalLateMinutes: { $sum: "$lateMinutes" },
              },
            },
          ]);

          const presentDays      = agg?.presentDays      || 0;
          const lateDays         = agg?.lateDays         || 0;
          const halfDays         = agg?.halfDays         || 0;
          const leaveDays        = agg?.leaveDays        || 0;
          const absentDays       = agg?.absentDays       || 0;
          const totalLateMinutes = agg?.totalLateMinutes || 0;

          const grossSalary      = emp.monthlySalary || 0;
          const perDayRate       = totalWorkingDays > 0 ? grossSalary / totalWorkingDays : 0;
          const daysInMonth      = new Date(y, m, 0).getDate();

          // Salary component breakdown — use employee overrides
          const basicSalary      = emp.basicAmt > 0 ? emp.basicAmt : Math.round(grossSalary * ((emp.basicPct ?? 40) / 100));
          const hra              = emp.hraAmt   > 0 ? emp.hraAmt   : Math.round(basicSalary * ((emp.hraPct   ?? 40) / 100));
          const da               = emp.daAmt    > 0 ? emp.daAmt    : Math.round(basicSalary * ((emp.daPct    ?? 10) / 100));
          const specialAllowance = Math.max(0, grossSalary - basicSalary - hra - da);

          // Attendance deductions
          const isProbationary2   = emp.employmentType === "probationary";
          const LEAVE_ENTITLEMENT = isProbationary2 ? 0 : 1.5;
          const excessLeaveDays   = Math.max(0, leaveDays - LEAVE_ENTITLEMENT);
          const absentDeduction   = absentDays      * perDayRate;
          const halfDayDeduction  = halfDays        * (perDayRate / 2);
          const leaveDeduction    = excessLeaveDays * perDayRate;
          const lateDeduction     = 0;

          // Statutory deductions — respecting employee flags
          const pfEmployee      = emp.pfApplicable  !== false ? (emp.pfFixed  || 0) : 0;
          const pfEmployer      = pfEmployee;
          const esi             = emp.esiApplicable             ? (emp.esiFixed || 0) : 0;
          const professionalTax = emp.ptApplicable  !== false   ? (emp.ptFixed  || 0)
            : 0;

          const totalDeduction = Math.round(
            (absentDeduction + halfDayDeduction + leaveDeduction + pfEmployee + esi + professionalTax) * 100
          ) / 100;
          const netSalary = Math.max(0, Math.round((grossSalary - totalDeduction) * 100) / 100);

          const record = await SalaryRecord.findOneAndUpdate(
            { employeeId: emp._id, month: m, year: y },
            {
              employeeId:    emp._id,
              employeeName:  emp.name,
              employeeCode:  emp.employeeId,
              branch:        emp.branch,
              department:    emp.department,
              designation:   emp.designation,
              month:         m,
              year:          y,
              totalWorkingDays,
              daysInMonth,
              presentDays,
              absentDays,
              lateDays,
              halfDays,
              leaveDays,
              totalLateMinutes,
              grossSalary,
              basicSalary,
              hra,
              da,
              specialAllowance,
              perDayRate:       Math.round(perDayRate * 100) / 100,
              monthlyLeaveEntitlement: LEAVE_ENTITLEMENT,
              excessLeaveDays:  Math.round(excessLeaveDays * 100) / 100,
              absentDeduction:  Math.round(absentDeduction  * 100) / 100,
              halfDayDeduction: Math.round(halfDayDeduction * 100) / 100,
              leaveDeduction:   Math.round(leaveDeduction   * 100) / 100,
              lateDeduction:    0,
              pfEmployee,
              pfEmployer,
              esi,
              professionalTax,
              totalDeduction,
              netSalary,
              generatedBy:   generatedBy || "",
              generatedAt:   new Date(),
            },
            { upsert: true, new: true }
          );

          generated.push(record);
        } catch (e) {
          errors.push({ employeeId: String(emp._id), name: emp.name, error: e.message });
        }
      })
    );

    return res.json({ success: true, data: { generated, errors } });
  } catch (err) {
    console.error("generateBulkSalary error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function getSalaryRecords(req, res) {
  try {
    const { month, year, branch, status } = req.query;
    const filter = {};
    if (month)  filter.month  = Number(month);
    if (year)   filter.year   = Number(year);
    if (branch) filter.branch = branch;
    if (status) filter.status = status;

    const records = await SalaryRecord.find(filter).sort({ year: -1, month: -1 }).lean();
    return res.json({ success: true, data: records });
  } catch (err) {
    console.error("getSalaryRecords error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function getSalaryById(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid salary record ID format" });
    }
    const record = await SalaryRecord.findById(req.params.id)
      .populate("employeeId")
      .lean();
    if (!record) return res.status(404).json({ success: false, message: "Salary record not found" });
    return res.json({ success: true, data: record });
  } catch (err) {
    console.error("getSalaryById error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function markSalaryPaid(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid salary record ID format" });
    }
    const { paidDate, paymentMethod, notes } = req.body;

    const record = await SalaryRecord.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status:        "paid",
          paidDate:      paidDate       ? new Date(paidDate) : new Date(),
          paymentMethod: paymentMethod  || "",
          notes:         notes          || "",
        },
      },
      { new: true }
    );

    if (!record) return res.status(404).json({ success: false, message: "Salary record not found" });
    return res.json({ success: true, data: record });
  } catch (err) {
    console.error("markSalaryPaid error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

export async function generateSalarySlipPDF(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid salary record ID format" });
    }
    const record = await SalaryRecord.findById(req.params.id)
      .populate("employeeId")
      .lean();

    if (!record) {
      return res.status(404).json({ success: false, message: "Salary record not found" });
    }

    // employeeId is populated; if the employee was deleted, it may be null
    const emp = (typeof record.employeeId === "object" && record.employeeId !== null)
      ? record.employeeId
      : {};

    // Month name
    const monthNames = [
      "", "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const monthName  = monthNames[record.month] || String(record.month);
    const periodStr  = `${monthName} ${record.year}`;
    const filename   = `salary-slip-${record.employeeCode || emp.employeeId || "emp"}-${record.year}-${String(record.month).padStart(2, "0")}.pdf`;

    // Pull per-day attendance for the period — used for the daily timings table.
    const attendanceRows = await Attendance.find({
      employeeId: record.employeeId?._id || record.employeeId,
      month:      record.month,
      year:       record.year,
    }).sort({ date: 1 }).lean();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    doc.pipe(res);

    const pageWidth  = doc.page.width  - 100; // accounting for margins
    const primaryColor = "#1a237e";
    const accentColor  = "#e3f2fd";

    /* Helper — format a Date as "09:32 AM" in IST */
    const fmtTime = (d) => {
      if (!d) return "—";
      try {
        return new Date(d).toLocaleTimeString("en-IN", {
          hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
        });
      } catch { return "—"; }
    };
    /* Helper — derive break minutes from check-in/out vs worked hours */
    const breakMins = (row) => {
      if (!row.checkIn || !row.checkOut) return null;
      const grossMs = new Date(row.checkOut) - new Date(row.checkIn);
      if (grossMs <= 0) return null;
      const grossMins  = Math.round(grossMs / 60000);
      const workedMins = Math.round((Number(row.workingHours) || 0) * 60);
      const diff       = grossMins - workedMins;
      return diff > 0 ? diff : 0;
    };
    const fmtMins = (m) => {
      if (m == null) return "—";
      if (m < 60)    return `${m}m`;
      const h = Math.floor(m / 60), rest = m % 60;
      return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
    };

    // ---- Company Header ----
    doc.fontSize(20).fillColor(primaryColor).font("Helvetica-Bold")
      .text("Nakshatra Namaha Creations", 50, 50, { align: "center", width: pageWidth });

    doc.fontSize(12).fillColor("#555").font("Helvetica")
      .text(`Branch: ${record.branch || emp.branch || ""}`, 50, 75, { align: "center", width: pageWidth });

    // Divider
    doc.moveTo(50, 100).lineTo(50 + pageWidth, 100).strokeColor(primaryColor).lineWidth(2).stroke();

    // ---- Salary Slip Title ----
    doc.fontSize(16).fillColor(primaryColor).font("Helvetica-Bold")
      .text("SALARY SLIP", 50, 115, { align: "center", width: pageWidth });

    doc.fontSize(11).fillColor("#333").font("Helvetica")
      .text(`Pay Period: ${periodStr}`, 50, 137, { align: "center", width: pageWidth });

    // Divider
    doc.moveTo(50, 160).lineTo(50 + pageWidth, 160).strokeColor("#ccc").lineWidth(1).stroke();

    // ---- Employee Details ----
    doc.fontSize(12).fillColor(primaryColor).font("Helvetica-Bold")
      .text("Employee Details", 50, 175);

    const empDetails = [
      ["Name",         emp.name         || record.employeeName || ""],
      ["Employee ID",  emp.employeeId   || record.employeeCode || ""],
      ["Designation",  emp.designation  || record.designation  || ""],
      ["Department",   emp.department   || record.department   || ""],
      ["Branch",       emp.branch       || record.branch       || ""],
      ["Joining Date", emp.joinedDate   ? new Date(emp.joinedDate).toDateString() : ""],
    ];

    let y = 195;
    const col1X = 50;
    const col2X = 200;

    doc.fontSize(10).fillColor("#333").font("Helvetica");
    for (const [label, value] of empDetails) {
      doc.font("Helvetica-Bold").text(label + ":", col1X, y, { width: 140 });
      doc.font("Helvetica").text(String(value), col2X, y, { width: pageWidth - 150 });
      y += 18;
    }

    y += 10;
    // Divider
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor("#ccc").lineWidth(1).stroke();
    y += 15;

    // ---- Attendance Summary ----
    doc.fontSize(12).fillColor(primaryColor).font("Helvetica-Bold")
      .text("Attendance Summary", col1X, y);
    y += 20;

    const calDays      = record.daysInMonth || new Date(record.year, record.month, 0).getDate();
    const daysAttended = (record.presentDays || 0) + (record.lateDays || 0) + (record.halfDays || 0);
    const attLeft = [
      ["Days in Month",    calDays],
      ["Working Days",     record.totalWorkingDays],
      ["Days Attended",    daysAttended],
      ["Present (Full)",   record.presentDays],
    ];
    const attRight = [
      ["Absent Days",      record.absentDays],
      ["Late Days",        record.lateDays],
      ["Half Days",        record.halfDays],
      ["Leave Days",       record.leaveDays],
    ];

    const col3X = 350;
    doc.fontSize(10).fillColor("#333");
    const attLen = Math.max(attLeft.length, attRight.length);
    for (let i = 0; i < attLen; i++) {
      if (attLeft[i]) {
        doc.font("Helvetica-Bold").text(attLeft[i][0] + ":", col1X, y, { width: 130 });
        doc.font("Helvetica").text(String(attLeft[i][1] ?? "—"), 190, y);
      }
      if (attRight[i]) {
        doc.font("Helvetica-Bold").text(attRight[i][0] + ":", col3X, y, { width: 130 });
        doc.font("Helvetica").text(String(attRight[i][1] ?? "—"), col3X + 130, y);
      }
      y += 16;
    }

    y += 10;
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor("#ccc").lineWidth(1).stroke();
    y += 15;

    // ═════════════════════════════════════════════════════════
    //  EARNINGS (left column)  |  DEDUCTIONS (right column)
    // ═════════════════════════════════════════════════════════
    const halfW       = (pageWidth - 12) / 2;             // 12px gutter between cols
    const leftColX    = col1X;
    const rightColX   = col1X + halfW + 12;
    const sectionStartY = y;

    // ── EARNINGS / ALLOWANCES (LEFT) ──
    let yL = sectionStartY;
    doc.fontSize(11).fillColor(primaryColor).font("Helvetica-Bold")
      .text("Earnings / Allowances", leftColX, yL);
    yL += 18;

    const earnRows = [
      ["Basic Salary (40%)",         record.basicSalary || Math.round((record.grossSalary || 0) * 0.40)],
      ["HRA - House Rent Allow.",    record.hra         || Math.round((record.grossSalary || 0) * 0.16)],
      ["DA - Dearness Allowance",    record.da          || Math.round((record.grossSalary || 0) * 0.04)],
      ["Special Allowance",          record.specialAllowance ?? Math.max(0, (record.grossSalary || 0) * 0.40)],
    ];

    const earnLabelW  = halfW - 78;  // leave room for amount column
    const earnAmtX    = leftColX + halfW - 70;
    const earnAmtW    = 70;
    doc.fontSize(9.5).fillColor("#333");
    for (const [label, value] of earnRows) {
      doc.font("Helvetica").fillColor("#333").text(label, leftColX + 4, yL, { width: earnLabelW });
      doc.font("Helvetica-Bold").fillColor("#0f172a")
        .text(`INR ${Number(value).toFixed(2)}`, earnAmtX, yL, { align: "right", width: earnAmtW });
      yL += 14;
    }
    yL += 4;
    doc.rect(leftColX, yL - 2, halfW, 22).fill(accentColor);
    doc.fontSize(10).fillColor(primaryColor).font("Helvetica-Bold")
      .text("Gross Earnings:", leftColX + 4, yL + 4, { width: earnLabelW });
    doc.text(`INR ${(record.grossSalary || 0).toFixed(2)}`, earnAmtX, yL + 4, { align: "right", width: earnAmtW });
    yL += 30;

    // ── DEDUCTIONS (RIGHT) ──
    let yR = sectionStartY;
    doc.fontSize(11).fillColor(primaryColor).font("Helvetica-Bold")
      .text("Deductions", rightColX, yR);
    yR += 18;

    const pfEmp        = record.pfEmployee      || 0;
    const pt           = record.professionalTax || 0;
    const leaveEntitle = record.monthlyLeaveEntitlement ?? 1.5;
    const excessLeave  = record.excessLeaveDays || 0;
    const leaveDeduct  = record.leaveDeduction  || 0;

    const dedLabelW = halfW - 78;
    const dedAmtX   = rightColX + halfW - 70;
    const dedAmtW   = 70;

    doc.fontSize(9).font("Helvetica-Bold").fillColor("#475569")
      .text("Attendance-Based:", rightColX + 4, yR);
    yR += 12;
    doc.fontSize(9.5);

    let hasAttDeduct = false;
    if ((record.absentDeduction || 0) > 0) {
      doc.font("Helvetica").fillColor("#333")
        .text(`Absent (${record.absentDays} day${record.absentDays !== 1 ? "s" : ""})`, rightColX + 8, yR, { width: dedLabelW });
      doc.font("Helvetica-Bold").fillColor("#dc2626")
        .text(`- INR ${Number(record.absentDeduction).toFixed(2)}`, dedAmtX, yR, { align: "right", width: dedAmtW });
      yR += 13; hasAttDeduct = true;
    }
    if ((record.halfDayDeduction || 0) > 0) {
      doc.font("Helvetica").fillColor("#333")
        .text(`Half-Day (${record.halfDays} day${record.halfDays !== 1 ? "s" : ""})`, rightColX + 8, yR, { width: dedLabelW });
      doc.font("Helvetica-Bold").fillColor("#dc2626")
        .text(`- INR ${Number(record.halfDayDeduction).toFixed(2)}`, dedAmtX, yR, { align: "right", width: dedAmtW });
      yR += 13; hasAttDeduct = true;
    }
    // Leave
    doc.font("Helvetica").fillColor("#333")
      .text(`Leave Used: ${record.leaveDays || 0} day${(record.leaveDays || 0) !== 1 ? "s" : ""} (Entitlement ${leaveEntitle})`, rightColX + 8, yR, { width: dedLabelW });
    if (leaveDeduct > 0) {
      doc.font("Helvetica-Bold").fillColor("#dc2626")
        .text(`- INR ${leaveDeduct.toFixed(2)}`, dedAmtX, yR, { align: "right", width: dedAmtW });
      yR += 13;
      doc.font("Helvetica").fontSize(8).fillColor("#888")
        .text(`Excess ${excessLeave} day${excessLeave !== 1 ? "s" : ""}`, rightColX + 8, yR, { width: dedLabelW });
      doc.fontSize(9.5);
    } else {
      doc.font("Helvetica").fillColor("#059669")
        .text("Within entitlement", dedAmtX, yR, { align: "right", width: dedAmtW });
    }
    yR += 14;

    if ((record.totalLateMinutes || 0) > 0) {
      doc.fontSize(8).font("Helvetica").fillColor("#888")
        .text(`Late: ${record.lateDays} day${record.lateDays !== 1 ? "s" : ""} (${record.totalLateMinutes} min) — info only`, rightColX + 8, yR, { width: halfW - 12 });
      yR += 12;
      doc.fontSize(9.5);
    }
    if (!hasAttDeduct && leaveDeduct === 0) {
      doc.font("Helvetica").fillColor("#059669").text("No attendance deductions", rightColX + 8, yR);
      yR += 12;
    }

    // Statutory
    yR += 4;
    doc.fontSize(9).font("Helvetica-Bold").fillColor("#475569")
      .text("Statutory:", rightColX + 4, yR);
    yR += 12;
    doc.fontSize(9.5).font("Helvetica").fillColor("#333")
      .text("PF Employee (12% Basic)", rightColX + 8, yR, { width: dedLabelW });
    doc.font("Helvetica-Bold").fillColor("#dc2626")
      .text(`- INR ${pfEmp.toFixed(2)}`, dedAmtX, yR, { align: "right", width: dedAmtW });
    yR += 13;

    if (pt > 0) {
      doc.font("Helvetica").fillColor("#333").text("Professional Tax", rightColX + 8, yR, { width: dedLabelW });
      doc.font("Helvetica-Bold").fillColor("#dc2626")
        .text(`- INR ${pt.toFixed(2)}`, dedAmtX, yR, { align: "right", width: dedAmtW });
      yR += 13;
    }

    yR += 6;
    doc.rect(rightColX, yR - 2, halfW, 22).fill(accentColor);
    doc.fontSize(10).fillColor(primaryColor).font("Helvetica-Bold")
      .text("Total Deductions:", rightColX + 4, yR + 4, { width: dedLabelW });
    doc.text(`- INR ${(record.totalDeduction || 0).toFixed(2)}`, dedAmtX, yR + 4, { align: "right", width: dedAmtW });
    yR += 30;

    // Move y to the bottom of the taller column
    y = Math.max(yL, yR);

    // Employer PF info — full-width footnote below both columns
    doc.fontSize(8).font("Helvetica").fillColor("#888")
      .text(`Note: Employer PF Contribution (12% of Basic): INR ${(record.pfEmployer || 0).toFixed(2)} — not deducted from employee.`,
        col1X, y, { width: pageWidth });
    y += 18;

    // ---- Net Salary ----
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor(primaryColor).lineWidth(2).stroke();
    y += 12;

    doc.rect(col1X, y - 4, pageWidth, 36).fill(primaryColor);
    doc.fontSize(14).fillColor("#ffffff").font("Helvetica-Bold")
      .text("NET SALARY PAYABLE:", col1X + 10, y + 6, { width: pageWidth - 170 });
    doc.fontSize(16)
      .text(`INR ${(record.netSalary || 0).toFixed(2)}`, col1X + pageWidth - 160, y + 4, { align: "right", width: 150 });

    y += 52;

    // ---- Payment Info (if paid) ----
    if (record.status === "paid") {
      doc.fontSize(10).fillColor("#2e7d32").font("Helvetica-Bold")
        .text(`Payment Status: PAID`, col1X, y);
      if (record.paidDate) {
        doc.font("Helvetica").fillColor("#333")
          .text(`  |  Paid Date: ${new Date(record.paidDate).toDateString()}`, { continued: false });
      }
      if (record.paymentMethod) {
        doc.text(`Payment Method: ${record.paymentMethod}`, col1X, y + 16);
      }
      y += 40;
    }

    // ═════════════════════════════════════════════════════════
    //  DAILY ATTENDANCE — login, logout, working hours, break
    // ═════════════════════════════════════════════════════════
    if (attendanceRows && attendanceRows.length > 0) {
      // New page if not enough vertical room left
      if (y > doc.page.height - 200) { doc.addPage(); y = 50; }

      doc.fontSize(12).fillColor(primaryColor).font("Helvetica-Bold")
        .text("Daily Attendance — Login / Logout / Break", col1X, y);
      y += 18;

      // Column geometry (totals: pageWidth)
      const cols = [
        { label: "Date",      w: 70,  align: "left"   },
        { label: "Day",       w: 50,  align: "left"   },
        { label: "Status",    w: 60,  align: "left"   },
        { label: "Login",     w: 70,  align: "center" },
        { label: "Logout",    w: 70,  align: "center" },
        { label: "Worked",    w: 60,  align: "right"  },
        { label: "Break",     w: 55,  align: "right"  },
        { label: "Late",      w: 60,  align: "right"  },
      ];
      const colX = (i) => col1X + cols.slice(0, i).reduce((s, c) => s + c.w, 0);

      // Header row
      doc.rect(col1X, y, pageWidth, 18).fill(primaryColor);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5);
      cols.forEach((c, i) => {
        const x = colX(i) + (c.align === "left" ? 4 : 0);
        doc.text(c.label, x, y + 5, { width: c.w - 6, align: c.align });
      });
      y += 18;

      // Data rows
      doc.font("Helvetica").fontSize(8.5);
      const STATUS_COLOR = {
        present:  "#16a34a",
        late:     "#ca8a04",
        "half-day": "#ea580c",
        absent:   "#dc2626",
        leave:    "#7c3aed",
        holiday:  "#64748b",
      };

      attendanceRows.forEach((row, idx) => {
        // New page if running off the bottom
        if (y > doc.page.height - 70) {
          doc.addPage();
          y = 50;
          // Repeat the header on the new page
          doc.rect(col1X, y, pageWidth, 18).fill(primaryColor);
          doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5);
          cols.forEach((c, i) => {
            const x = colX(i) + (c.align === "left" ? 4 : 0);
            doc.text(c.label, x, y + 5, { width: c.w - 6, align: c.align });
          });
          y += 18;
          doc.font("Helvetica").fontSize(8.5);
        }

        // Zebra stripe
        if (idx % 2 === 0) {
          doc.rect(col1X, y, pageWidth, 16).fill("#f8fafc");
        }

        const d        = new Date(row.date);
        const dateStr  = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
        const dayStr   = d.toLocaleDateString("en-IN", { weekday: "short" });
        const statusStr = (row.status || "absent").replace("-", " ");
        const inStr    = fmtTime(row.checkIn);
        const outStr   = fmtTime(row.checkOut);
        const workedStr = row.workingHours
          ? `${Number(row.workingHours).toFixed(2)} h`
          : "—";
        const brk      = breakMins(row);
        const breakStr = brk == null ? "—" : fmtMins(brk);
        const lateStr  = (row.lateMinutes || 0) > 0 ? `${row.lateMinutes}m` : "—";

        const values = [dateStr, dayStr, statusStr, inStr, outStr, workedStr, breakStr, lateStr];

        cols.forEach((c, i) => {
          const x = colX(i) + (c.align === "left" ? 4 : 0);
          if (i === 2) {
            // Color the status column by status
            doc.fillColor(STATUS_COLOR[row.status] || "#475569").font("Helvetica-Bold");
            doc.text(values[i], x, y + 4, { width: c.w - 6, align: c.align });
            doc.fillColor("#333").font("Helvetica");
          } else if (i >= 5) {
            // Numeric columns slightly bolder
            doc.fillColor("#0f172a").font("Helvetica-Bold");
            doc.text(values[i], x, y + 4, { width: c.w - 6, align: c.align });
            doc.fillColor("#333").font("Helvetica");
          } else {
            doc.fillColor("#334155");
            doc.text(values[i], x, y + 4, { width: c.w - 6, align: c.align });
          }
        });
        y += 16;
      });

      // Light separator below the table
      doc.moveTo(col1X, y).lineTo(col1X + pageWidth, y).strokeColor("#e2e8f0").lineWidth(1).stroke();
      y += 6;
      doc.fontSize(8).fillColor("#94a3b8").font("Helvetica-Oblique")
        .text("Break is computed as the difference between elapsed time (Logout − Login) and Worked hours.",
          col1X, y, { width: pageWidth });
      y += 16;
      doc.fillColor("#333").font("Helvetica");
    }

    // ---- Footer ----
    // New page if footer wouldn't fit
    if (y > doc.page.height - 80) { doc.addPage(); y = 50; }
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor("#ccc").lineWidth(1).stroke();
    y += 15;

    doc.fontSize(9).fillColor("#999").font("Helvetica")
      .text(`Generated on: ${new Date().toDateString()}`, col1X, y, { align: "left", width: pageWidth / 2 });

    doc.text("Authorised Signatory", col1X + pageWidth / 2, y, { align: "right", width: pageWidth / 2 });
    y += 30;
    doc.moveTo(col1X + pageWidth * 0.6, y)
      .lineTo(50 + pageWidth, y)
      .strokeColor("#333").lineWidth(1).stroke();
    doc.fontSize(9).fillColor("#666")
      .text("Signature", col1X + pageWidth * 0.6, y + 5, { align: "center", width: pageWidth * 0.4 });

    doc.end();
  } catch (err) {
    console.error("generateSalarySlipPDF error:", err);
    // Only send error response if headers not yet sent
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  }
}
