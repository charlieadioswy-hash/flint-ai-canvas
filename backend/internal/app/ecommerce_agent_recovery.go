package app

import (
	"context"
	"log/slog"
	"time"
)

const ecommerceAgentLeaseDuration = 45 * time.Second

func (s *Service) startEcommerceAgentRecoveryWorker(ctx context.Context) {
	s.runWorkerLoop(func(ctx context.Context) {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			runs, err := s.repo.ExpiredEcommerceAgentRuns(time.Now(), 100)
			if err != nil {
				slog.Warn("ecommerce run recovery scan failed", "error", err)
			}
			for _, run := range runs {
				if ctx.Err() != nil {
					return
				}
				if err := s.repo.RecoverExpiredEcommerceAgentRun(run.UserID, run.ID, time.Now()); err != nil {
					slog.Warn("ecommerce run recovery failed", "runId", run.ID, "error", err)
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
}
