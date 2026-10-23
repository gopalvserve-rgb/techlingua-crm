# HIDDEN MODULES

This file lists every module and screen that is **hidden** in the TechLingua CRM, plus what to keep in mind about each.

Hiding is **front-end only and fully reversible**:

- No screen, API endpoint, database table or saved data is deleted.
- Role permissions that were granted stay granted.
- A hidden screen does not appear in the sidebar, the menu search, the Site Map or the mobile app. Its URL lands on an empty page.

**Keep this file up to date.** When you hide or show anything, update this file in the same commit.

---

## 1. Learning & Assessment: whole module hidden (Oct 2026)

Requested by the client: hide the Learning & Assessment module and everything related to it.

### Menu screens hidden (all 14)

| Screen | Screen | Screen |
|---|---|---|
| Syllabus | Course Content | Study Material |
| Assignments | Tests & Scores | Question Bank |
| Question Categories | Test Templates | Tests / Exams |
| Evaluation Queue | Results & Analytics | Grade Schemes |
| Certificates (assessment) | Academic Progress (report cards) | |

### Related pieces on other screens, also hidden

| Where | What is hidden |
|---|---|
| Dashboard › Overview, Dashboard › Quick Stats, Student Dashboard | The **Assessments** block: Tests, Attempts, Pass rate, Average %, Pending evaluation, Certificates, the grade chart and the hardest-questions table |
| Student profile | The **Syllabus** tab and the **Report Cards** tab |
| Student profile › Academics tab | The **Tests & Scores** and **Assignments** sections. Batch, transfers and Manage stay visible. |
| Parent report-card share link (`/parent/report/<token>`) | Shows "This report is not available." |
| Administration › Roles › role editor | The permission rows of the hidden module. Grants a role already has are kept when the role is saved. |

The hidden permission groups in the role editor are:

- Tests & Scores
- Assignments (coursework)
- Study Material
- Report Cards
- Results & Grades
- Syllabus
- Course Content
- Question Categories
- Question Bank
- Tests / Exams
- Test Attempts
- Assignment Submissions
- Test Templates
- Grade Schemes
- Assessment Certificates

### Still visible on purpose

These belong to **Student & Academic Administration**, not Learning:

- Students
- Admissions
- Courses
- Batches
- Attendance
- Student **Certificates**: completion and participation certificates issued from the student record
- Placements
- Cross-Sell
- The student profile's **Status & LMS** tab

The public **certificate verification** page (`/verify/certificate/<code>`) also keeps working. A certificate that was already printed must still verify.

---

## 2. Operations: whole module hidden (Aug 2026, dev/111)

Catalog · Inventory · Assets · Vendor Management · Procurement

## 3. Individual screens hidden inside visible modules (Aug 2026, dev/111)

| Module | Hidden screens |
|---|---|
| HR & Workforce | Hiring · Bank · Performance · Incentives |
| Workspace & Productivity | Social Publisher · Social Comments · Social Inbox |
| Analytics & Reports | Scheduled Delivery · Counselor Analytics |
| Communication Intelligence | Intent Detection · Conversation Analytics · Sentiment Analysis · Objection Detection · Follow-up Suggestions |
| Calls | Telephony Settings · Call Routing · Conference Calling · Call Transfer |

---

## How to show a module again

Everything is controlled from **one place**: `web/src/specs.tsx`, in the "NAV VISIBILITY" block.

- **Whole module:** delete its id from `HIDDEN_MODULES` and deploy. For example, `'learning'` is Learning & Assessment and `'ops'` is Operations.
  - For Learning, that one change also brings back the dashboard block, the student-profile tabs and sections, the parent report link and the role-editor rows. They all check `isModuleHidden('learning')`.
- **A single screen:** delete its id from that module's set in `HIDDEN_SUBS` and deploy.

No database change or migration is needed either way. All data entered before hiding is still there.

## Note for developers

When you build something new that belongs to a hidden module and appears on another screen, wrap it in `isModuleHidden('<module>')`. Then list it in section 1 (or the matching section) of this file.
