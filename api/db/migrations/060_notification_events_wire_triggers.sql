-- 060 — Notification Events: mark the events whose REAL trigger is now wired as 'wired'.
--
-- Task 108. The catalog seeded 37 events, only 4 of which fired. We have now added a
-- safeFire(...) call at each real trigger site (fees / payments / refunds / academics /
-- certificates), so those events actually send their mapped, enabled templates. This flips
-- their trigger_status from 'pending' to 'wired' so the Notification Events screen shows an
-- accurate "wired vs seeded-only" badge. IDEMPOTENT — a plain UPDATE over a fixed key list,
-- safe to re-run.
UPDATE notification_event
   SET trigger_status = 'wired'
 WHERE event_key IN (
   -- Fees / Accounts
   'fee_invoice_generated',   -- GST invoice issued  (InvoiceService.issue)
   'payment_successful',      -- fee collected       (FeeService.collect: offline + Razorpay webhook)
   'payment_failed',          -- capture failed      (PaymentService.onFailed)
   'receipt_generated',       -- receipt created     (FeeService.collect)
   'installment_due_soon',    -- due-reminder sweep  (FeeReminderWorker: due_soon)
   'installment_due_today',   -- due-reminder sweep  (FeeReminderWorker: due_today)
   'payment_overdue',         -- due-reminder sweep  (FeeReminderWorker: overdue)
   'refund_initiated',        -- refund requested    (RefundService.request)
   'refund_completed',        -- refund approved     (RefundService.decide)
   'fee_fully_paid',          -- balance hits 0      (FeeService.collect)
   -- Academics / Students
   'batch_assigned',          -- first placement     (TransferService.transfer / StudentService.create)
   'batch_changed',           -- batch move          (TransferService.transfer)
   'student_welcome',         -- student created     (StudentService.convert / create)
   'student_absent',          -- attendance = Absent (AttendanceService.mark)
   -- Certificates
   'certificate_generated',   -- certificate created (CertificateService.issue / reissue)
   'certificate_issued'       -- status = Issued     (CertificateService.issue / reissue)
 );
