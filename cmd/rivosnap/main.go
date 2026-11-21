package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"rivosnap/internal/api"
	"rivosnap/internal/config"
	"rivosnap/internal/db"
	"rivosnap/internal/media"
	"rivosnap/internal/worker"
)

func resolveCommand(args []string) string {
	base := filepath.Base(args[0])
	joined := strings.Join(args, " ")
	if base == "node" || (len(args) > 1 && (args[1] == "-e" || args[1] == "--input-type=module")) {
		if strings.Contains(joined, "worker:heartbeat") {
			return "healthcheck-worker"
		}
		if strings.Contains(joined, "migrate deploy") {
			return "migrate"
		}
		return "healthcheck-api"
	}
	if len(args) > 1 {
		return args[1]
	}
	return "api"
}

func runHealthcheckAPI() int {
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Get("http://127.0.0.1:3000/ready")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return 0
	}
	return 1
}

func runHealthcheckWorker() int {
	redisURL := strings.TrimSpace(os.Getenv("REDIS_URL"))
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return 1
	}
	rdb := redis.NewClient(opts)
	defer rdb.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	n, err := rdb.Exists(ctx, "worker:heartbeat").Result()
	if err != nil || n == 0 {
		return 1
	}
	return 0
}

func main() {
	syscall.Umask(0o077)
	cmd := resolveCommand(os.Args)
	switch cmd {
	case "healthcheck-api":
		os.Exit(runHealthcheckAPI())
	case "healthcheck-worker":
		os.Exit(runHealthcheckWorker())
	}

	env, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	database, err := db.Connect(ctx, env)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer database.Close()

	if err := database.Migrate(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if cmd == "migrate" {
		return
	}

	redisOpts, err := redis.ParseURL(env.RedisURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	rdb := redis.NewClient(redisOpts)
	defer rdb.Close()

	store := media.NewStore(env)
	if err := store.InitDirs(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	if cmd == "worker" {
		proc := &worker.Processor{
			DB:    database,
			Store: store,
			Redis: rdb,
		}
		if err := proc.RunLoop(ctx); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	srv := api.NewServer(env, database, rdb, store)
	httpSrv := &http.Server{
		Addr:    "0.0.0.0:3000",
		Handler: srv.Handler(),
		// WriteTimeout stays unset: media streaming holds responses open.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		fmt.Printf(`{"level":30,"time":%d,"msg":"Server listening at http://127.0.0.1:3000"}`+"\n", time.Now().UnixMilli())
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	case err := <-errCh:
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}
