package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const marker = "https://bench.invalid/seed/"

var (
	localOrigin = regexp.MustCompile("^http://127[.]0[.]0[.]1:[1-9][0-9]*$")
	codePattern = regexp.MustCompile("^[A-Za-z0-9_-]{8}$")
)

type sample struct {
	started bool
	good    bool
	late    bool
	lag     time.Duration
	elapsed time.Duration
}

type scenario struct {
	name    string
	rate    int
	results []sample
	tokens  chan struct{}
	request func(int) bool
	pos     int
	sloP95  float64
	sloP99  float64
}

type metrics map[string]map[string]any

func number(name string, low, high int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value < low || value > high {
		panic("invalid benchmark value for " + name)
	}
	return value
}

func loadCodes() []string {
	raw, err := os.ReadFile(os.Getenv("SEED_FILE"))
	check(err)
	var codes []string
	check(json.Unmarshal(raw, &codes))
	if len(codes) != 20000 {
		panic("expected 20,000 deterministic synthetic seed codes")
	}
	seen := make(map[string]bool, len(codes))
	for _, code := range codes {
		if !codePattern.MatchString(code) || seen[code] {
			panic("invalid synthetic seed code")
		}
		seen[code] = true
	}
	return codes
}

func check(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Printf("capacity-go 1 (%s %s/%s)\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
		return
	}
	os.Exit(run())
}

func run() int {
	if len(os.Args) < 2 || os.Args[1] != "run" {
		panic("expected run or version")
	}
	var out string
	for i := 2; i+1 < len(os.Args); i++ {
		if os.Args[i] == "--summary-export" {
			out = os.Args[i+1]
			break
		}
	}
	if out == "" {
		panic("missing summary export")
	}
	phase := os.Getenv("BENCHMARK_PHASE")
	if phase != "measure" && phase != "warmup" {
		panic("invalid phase")
	}
	origins := strings.Split(os.Getenv("TARGET"), ",")
	if len(origins) != 2 || origins[0] == origins[1] {
		panic("two distinct loopback origins are required")
	}
	for _, origin := range origins {
		if !localOrigin.MatchString(origin) {
			panic("load must stay on loopback")
		}
		if _, err := url.ParseRequestURI(origin); err != nil {
			panic(err)
		}
	}
	codes := loadCodes()
	seed := uint32(number("BENCHMARK_SEED", 0, math.MaxUint32))
	var salt uint32
	if phase == "warmup" {
		salt = 0x66756a3b
	}
	duration := number("BENCHMARK_SECONDS", 1, 900)
	redirectRPS := number("REDIRECT_RPS", 1, 20000)
	shortenRPS := number("SHORTEN_RPS", 1, 20000)
	redirectVUs := number("REDIRECT_VUS", 1, 5000)
	shortenVUs := number("SHORTEN_VUS", 1, 5000)

	transport := &http.Transport{
		DialContext:  (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns: 1024, MaxIdleConnsPerHost: 600, IdleConnTimeout: 65 * time.Second,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport, Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	redirect := func(origin, code string) bool {
		response, err := client.Get(origin + "/r/" + code)
		if err != nil {
			return false
		}
		defer response.Body.Close()
		_, err = io.Copy(io.Discard, response.Body)
		return err == nil && response.StatusCode == http.StatusFound && response.Header.Get("Location") == marker+code
	}
	if !redirect(origins[0], codes[0]) || !redirect(origins[1], codes[len(codes)-1]) {
		panic("target did not return the expected synthetic seed links")
	}
	redirectOp := scenario{
		name: "redirect", rate: redirectRPS, results: make([]sample, duration*redirectRPS),
		tokens: make(chan struct{}, redirectVUs), sloP95: 100, sloP99: 250,
		request: func(i int) bool {
			x := seed ^ salt ^ uint32(i+1)*0x9e3779b1 ^ 2
			x = (x ^ (x >> 16)) * 0x7feb352d
			x = (x ^ (x >> 15)) * 0x846ca68b
			x ^= x >> 16
			selected := 200 + int((uint64(x)*19800)>>32)
			return redirect(origins[i%2], codes[selected])
		},
	}
	shortenOp := scenario{
		name: "shorten", rate: shortenRPS, results: make([]sample, duration*shortenRPS),
		tokens: make(chan struct{}, shortenVUs), sloP95: 300, sloP99: 800,
		request: func(i int) bool {
			original := fmt.Sprintf("https://bench.invalid/new/%s/%d/%d", phase, seed, i)
			payload := bytes.NewBufferString(fmt.Sprintf("{\"url\":%q}", original))
			resp, err := client.Post(origins[i%2]+"/shorten", "application/json", payload)
			if err != nil {
				return false
			}
			defer resp.Body.Close()
			var parsed struct {
				OriginalURL string
				Code        string
			}
			err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&parsed)
			_, drainError := io.Copy(io.Discard, resp.Body)
			return resp.StatusCode == http.StatusCreated && err == nil && drainError == nil &&
				parsed.OriginalURL == original && codePattern.MatchString(parsed.Code)
		},
	}

	report := metrics{}
	gate := schedule(&redirectOp, &shortenOp, phase, out, report)
	encoded, err := json.MarshalIndent(map[string]any{"metrics": report}, "", "  ")
	check(err)
	check(os.WriteFile(out, encoded, 0644))
	if gate {
		return 0
	}
	return 99
}

func schedule(a, b *scenario, phase, out string, report metrics) bool {
	const maxLate = 20 * time.Millisecond
	start := time.Now().Add(50 * time.Millisecond)
	var wg sync.WaitGroup
	next := func(s *scenario) time.Duration {
		if s.pos == len(s.results) {
			return time.Duration(math.MaxInt64)
		}
		return time.Duration(int64(s.pos) * int64(time.Second) / int64(s.rate))
	}
	for a.pos < len(a.results) || b.pos < len(b.results) {
		op := a
		if next(b) < next(a) {
			op = b
		}
		planned := start.Add(next(op))
		if wait := time.Until(planned); wait > 0 {
			time.Sleep(wait)
		}
		slot := op.pos
		op.pos++
		lag := time.Since(planned)
		if lag > maxLate {
			op.results[slot] = sample{lag: lag, late: true}
			continue
		}
		select {
		case op.tokens <- struct{}{}:
			wg.Add(1)
			go func(s *scenario, i int, target time.Time) {
				begin := time.Now()
				lag := begin.Sub(target)
				if lag > maxLate {
					s.results[i] = sample{lag: lag, late: true}
				} else {
					good := s.request(i)
					s.results[i] = sample{started: true, good: good, lag: lag, elapsed: time.Since(begin)}
				}
				<-s.tokens
				wg.Done()
			}(op, slot, planned)
		default:
			op.results[slot] = sample{lag: lag}
		}
	}
	wg.Wait()

	check(saveSamples(out+".samples.tsv.gz", a, b))
	allLags := make([]float64, 0, len(a.results)+len(b.results))
	dropped, late := 0, 0
	pass := true
	for _, op := range []*scenario{a, b} {
		times := make([]float64, 0, len(op.results))
		passes := 0
		for _, entry := range op.results {
			allLags = append(allLags, float64(entry.lag)/float64(time.Millisecond))
			if entry.started {
				times = append(times, float64(entry.elapsed)/float64(time.Millisecond))
			} else {
				dropped++
			}
			if entry.good {
				passes++
			}
			if entry.late {
				late++
			}
		}
		sort.Float64s(times)
		p95, p99 := quantile(times, .95), quantile(times, .99)
		prefix := "benchmark_" + op.name
		report[prefix+"_completed"] = map[string]any{"count": len(times)}
		report[prefix+"_success"] = map[string]any{"passes": passes, "fails": len(times) - passes}
		report[prefix+"_latency_ms"] = map[string]any{"p(95)": p95, "p(99)": p99}
		pass = pass && len(times) == len(op.results) && float64(passes) > .99*float64(len(times))
		if phase == "measure" {
			pass = pass && p95 < op.sloP95 && p99 < op.sloP99
		}
	}
	sort.Float64s(allLags)
	p99 := quantile(allLags, .99)
	report["dropped_iterations"] = map[string]any{"count": dropped}
	report["generator_lag_ms"] = map[string]any{"p(99)": p99, "unscheduled": late}
	fmt.Printf("scheduler p99=%.3fms late=%d dropped=%d\n", p99, late, dropped)
	return pass && p99 < 5 && late == 0
}

func quantile(ordered []float64, p float64) float64 {
	if len(ordered) == 0 {
		return 1e9
	}
	place := p * float64(len(ordered)-1)
	i := int(place)
	if i == len(ordered)-1 {
		return ordered[i]
	}
	return ordered[i] + (place-float64(i))*(ordered[i+1]-ordered[i])
}

func saveSamples(name string, scenarios ...*scenario) error {
	f, err := os.Create(name)
	if err != nil {
		return err
	}
	z, err := gzip.NewWriterLevel(f, gzip.BestSpeed)
	if err != nil {
		f.Close()
		return err
	}
	w := bufio.NewWriterSize(z, 1<<16)
	fmt.Fprintln(w, "endpoint\tindex\tschedule_lag_us\tlatency_us\tsuccess\tstarted\tlate")
	var line []byte
	for _, scenario := range scenarios {
		for i, value := range scenario.results {
			line = append(line[:0], scenario.name...)
			line = strconv.AppendInt(append(line, '\t'), int64(i), 10)
			line = strconv.AppendInt(append(line, '\t'), value.lag.Microseconds(), 10)
			line = strconv.AppendInt(append(line, '\t'), value.elapsed.Microseconds(), 10)
			line = strconv.AppendBool(append(line, '\t'), value.good)
			line = strconv.AppendBool(append(line, '\t'), value.started)
			line = strconv.AppendBool(append(line, '\t'), value.late)
			w.Write(append(line, '\n'))
		}
	}
	return errors.Join(w.Flush(), z.Close(), f.Close())
}
