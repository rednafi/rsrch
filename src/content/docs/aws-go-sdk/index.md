---
title: Go tricks from the AWS SDK for Go v2
slug: aws-go-sdk
description: Client design, resilience, concurrency, IO, code generation and testing tricks from the AWS SDK for Go v2 and smithy-go, each with a file and line in the source.
date: 2026-10-24
tags: [go, aws, sdk-design]
---

This document lists Go tricks from the AWS SDK for Go v2 and from smithy-go, its runtime. Many Go programmers do not know these tricks.
The tricks are about client design, resilience, concurrency, IO, the file system, code generation and tests.
Each trick has a file and a line in the SDK, so you can read the source.
The document has 19 complete programs. All of them compile and run. The last section tells you how to run them.

The language follows the rules of ASD-STE100 Simplified Technical English. The sentences are short, in the active voice, and use simple words.
Code names, such as `DoChan` or `WriterAt`, are technical names. They stay as they are.

## Contents

1. [How I did the research](#how-i-did-the-research)
2. [A well behaved client](#a-well-behaved-client)
3. [Resilience tricks](#resilience-tricks)
4. [Stack a circuit breaker and a retry](#stack-a-circuit-breaker-and-a-retry)
5. [Concurrency tricks](#concurrency-tricks)
6. [IO tricks](#io-tricks)
7. [File system tricks](#file-system-tricks)
8. [Code generation tricks](#code-generation-tricks)
9. [Testing tricks](#testing-tricks)
10. [Small Go idioms](#small-go-idioms)
11. [Bugs that I found, and the lesson from each](#bugs-that-i-found-and-the-lesson-from-each)
12. [The most important tricks](#the-most-important-tricks)
13. [How to run the examples](#how-to-run-the-examples)

## How I did the research

I cloned `github.com/aws/aws-sdk-go-v2` at commit `aae188a` and `github.com/aws/smithy-go` at commit `f0c489f`.

| Part | Files | Lines | Notes |
|---|---|---|---|
| Go files, both repositories | 32,249 | 18.2 million in declarations | 31,220 of them have a "Code generated" header |
| Hand-written Go, not tests | 621 | 87,441 | the core: `aws`, `config`, `credentials`, `feature`, `internal`, and smithy-go |
| Hand-written Go, tests | 409 | 97,670 | |
| Generated Go, `service/` and protocol tests | 31,219 | the rest | 4,440 of them are generated tests |
| Java code generator | 329 | 63,390 | it writes all of the generated Go |

### The method for each part of the code

| Part | Files | Lines | How I covered it | Ledger check |
|---|---|---|---|---|
| Hand-written Go, not tests | 621 | 87,441 | read in full | 621 of 621 files, 87,441 of 87,441 lines |
| Hand-written Go, tests | 409 | 97,673 | read in full | 409 of 409 files, 97,673 of 97,673 lines |
| Java code generator | 329 | 63,392 | read in full | 329 of 329 files, 63,392 of 63,392 lines |
| Generated Go | 31,219 | 19,790,892 | each line put into one of 2,984 line shapes; each shape and each rare line read; each value checked by a tool (see below) | 9,664 of 9,664 shapes and rare lines; 1,075 of 1,075 numbers |

**Hand-written code, tests and the Java generator.** I split the 1,359 files into 24 parts of about 11,000 lines. A reader agent read each part, line by line.
Each agent wrote one ledger line for each file: the path, the line count, the number of lines read, and a result: one new trick or bug, or "none".
A script compared the ledgers with the file lists and with `wc -l`. Each of the three groups had no file absent and no file with a short read.
The agents reported 590 findings. For each bug in the bugs table, I ran a program or a test. One agent claim was wrong, and the [bugs section](#bugs-that-i-found-and-the-lesson-from-each) says so.

**Generated code, line by line.** A generator writes the same lines many times, with different names. A tool read each of the 19,790,892 lines of the 31,219 generated files:

1. It split each file into tokens with `go/scanner`. It put the tokens of each line together.
2. It made a "shape" for each line. The shape keeps the keywords, the operators and the calls to shared packages, for example `strconv.ParseInt`. It removes the local names, the literals and the comments.
3. The 17,500,334 lines that have tokens (the others are blank) have only **2,984 shapes**. 99.962% of the lines have a shape that occurs in two or more services.
4. The other 6,680 lines have a shape that occurs in only one service. These are the lines that no template explains.
5. Reader agents read one real example line of each of the 2,984 shapes. They also read each of the 6,680 rare lines, with the source file open for context. Each wrote one ledger row for each shape or line. The script checked 9,664 of 9,664 rows, with the same keys in the same order.

Thus each generated line is a line that a reader read, or it has the same shape as a line that a reader read.
An earlier pass at the statement level gave the same picture: 7,469,672 generated statements, 29,036 statement shapes, and 2,076 rare lines of logic.

**Generated code, value by value.** The shapes remove the names and the literals. Thus I checked the values in a separate pass. The generated code has 46.6 million value tokens:

| Kind of value | Tokens | Distinct | How I checked each value | Result |
|---|---|---|---|---|
| Names (identifiers) | 40,944,771 | 689,316 | `go vet` on all 1,998 packages of the 494 modules, with test files. The compiler resolves and type-checks each name. | 0 problems |
| Numbers | 943,047 | 1,075 | A reader read each distinct number, with a ledger (1,075 of 1,075 rows). It also checked the BDD arrays of all 437 endpoint files, and the member counts of all 114,098 schemas. | test data bugs only (bug 28) |
| Strings | 3,465,497 | 256,613 | Each string is in a class that a tool proves (see below), or a reader read it. Readers read 55,026 distinct strings, with a ledger. The tools also checked each format string, regular expression, time layout, struct tag, header name, URL, enum list and region key. | bugs 29, 31; small issues below |
| Comments | 1,237,149 | 474,798 | Readers read 21,755 distinct template comments and 60,874 other distinct comments, with a ledger. The other comment lines are copies of the API documentation in the service models (see below). | bug 30; about 470 documentation errors |

I proved that `go vet` really checked all the packages. An overlay added a file with a printf bug to `service/s3` and to `service/xray`, the last service in order. The full run reported exactly those two problems and no other problem.
staticcheck (`SA1`, `SA4`, `SA5`, `SA6`, `SA9`) over the same packages found 2 problems in generated code. Both are bug 20. The other reports were in hand-written code, or were uses of deprecated fields, which the generated code must still fill.

**How the tools classify strings and comments.** A string is in a proved class when one of these rules is true:

| Class | String tokens | Rule |
|---|---|---|
| Test placeholder | 988,517 | the form `"__Name__"` |
| Same text as a Go name | 408,257 | the string is an identifier, and the same identifier is in the same file; the compiler checks the identifier |
| Wire name | 358,659 | a name of the form `[A-Za-z0-9_-]+` in a serializer, deserializer, schema or types file |
| Enum value | 108,962 | a value in `enums.go`; no list has a duplicate |
| Endpoint name | 73,812 | a name in an endpoint file |
| URL | 30,023 | a URL; the host has only valid characters |
| Shape ID | 7,514 | the form `namespace#Name$member` |
| **Read by a reader** | **1,489,753** | **the 55,026 distinct values of all other strings** |

A comment line is a copy of the model documentation when each 3-word sequence in the line is also in the model of that service. 556,155 comment lines are copies.
Comment lines that are the same in two or more services are templates, and readers read each distinct template text. Readers also read each other comment line. The 48 ledgers have 137,655 of 137,655 rows.

**The limit of this method.** A reader did not read each copy of a template line, and did not read the strings and comments that are in a proved class.
For a proved class, the tool proves that the value is a copy of something else, for example a Go name or the model documentation. It does not prove that the original is correct. A wrong word in the AWS model documentation is also in the SDK.
Without the copies, the generated code still has 3,185,771 distinct lines (exact text, blank lines removed). A full read by eye of those lines is more than 1,000 reader runs of 3,000 lines. Most of the lines are copies of a template or of the model documentation, which the method above already covers. I did not do that read.

### Other notes

For each bug in this document, I wrote a test or a program and ran it. The proof is in the [bugs section](#bugs-that-i-found-and-the-lesson-from-each).
A file path in this document starts with the name of the repository, for example `aws-sdk-go-v2/aws/retry/standard.go:296`.
A script checks each SDK quote in this document against the real file.

Your blog already has posts about a circuit breaker, a retry function, `singleflight`, functional options, middleware, re-exec tests, fakes and test flags.
This document does not explain those topics again. It shows what the SDK does in addition to them.

## A well behaved client

### 1. Copy the options for each call, then apply the call options

Each generated client has an `Options` struct. `New` copies it, sets defaults, applies your functions, and then runs "finalize" steps.
Each operation copies the options again. Then it applies the functions that you give to that call only.
A change for one call cannot change the client or a different goroutine.

<!-- sdk: aws-sdk-go-v2/service/sqs/options.go:147 -->
```go
func (o Options) Copy() Options {
	to := o
	to.APIOptions = make([]func(*middleware.Stack) error, len(o.APIOptions))
	copy(to.APIOptions, o.APIOptions)
	to.Interceptors = o.Interceptors.Copy()

	return to
}
```

The order in `New` is: copy, `resolveX` (defaults), your `optFns`, then `finalizeX`.
Each `resolveX` function returns at once when you set the value, so your value always wins.
See `aws-sdk-go-v2/service/sqs/api_client.go:197`.
The copy of the slice is important. Without it, an `append` in one call can write into the backing array of the client.

### 2. Give the client a retryer factory, not a retryer

The retryer has state: a token bucket. If two clients share one retryer, then a failure in service A uses up the retries of service B.
For this reason, `aws.Config.Retryer` is a function that returns a new retryer (`aws-sdk-go-v2/aws/config.go:107`).
Use the same idea for each object with state in your own clients: a rate limiter, a breaker, or a cache.

### 3. Put a bound on each phase of the request

`awshttp.BuildableClient` sets each timeout of the transport. Each `With...` method returns a copy.
The client builds the `http.Client` one time only, on the first `Do`, with `sync.Once`.

<!-- sdk: aws-sdk-go-v2/aws/transport/http/client.go:85 -->
```go
func (b *BuildableClient) Do(req *http.Request) (*http.Response, error) {
	b.initOnce.Do(b.build)

	return b.client.Do(req)
```

The default transport has `MaxConnsPerHost`, `IdleConnTimeout` (90 s), `TLSHandshakeTimeout`, and `ExpectContinueTimeout` (1 s).
The last one stops an upload that waits forever for a server that never sends `100 Continue`.
The redirect rule follows only 307 and 308, because they keep the method.
It also removes `X-Amz-Security-Token` when the redirect goes to a different host. The standard library removes only `Authorization`.

<!-- sdk: aws-sdk-go-v2/aws/transport/http/client.go:360 -->
```go
	switch resp.StatusCode {
	case 307, 308:
		// Only allow 307 and 308 redirects as they preserve the method.

		// If redirecting to a different host, remove X-Amz-Security-Token header
		// to prevent credentials from being sent to a different host, similar to
		// how Authorization header is handled by the HTTP client.
		if len(via) > 0 {
			lastRequest := via[len(via)-1]
			if lastRequest.URL.Host != r.URL.Host {
				r.Header.Del("X-Amz-Security-Token")
			}
		}
```

### 4. Use the five steps of the middleware stack

smithy-go has five steps: Initialize, Serialize, Build, Finalize and Deserialize. Each middleware has an ID.
You can put a new middleware `Before` or `After` an ID. This is better than a plain chain of wrappers, because each position has a name.
The important position is the `Retry` middleware in the Finalize step:

- A middleware before `Retry` runs one time for each operation.
- A middleware after `Retry` runs one time for each attempt.

Example 4 prints the stack. You can see that `GetIdentity`, `ResolveEndpointV2` and `Signing` come after `Retry`.
Thus the SDK gets the credentials, finds the endpoint and signs the request again for each attempt.

### 5. Example: a well behaved SQS client

This program uses a fake SQS server. The server fails three times, then it succeeds.
The client has its own retryer, timeouts for each phase, a middleware for each operation, and a change for one call only.

Example 1, file `wellbehaved/main.go`:

<!-- file: wellbehaved/main.go -->
```go
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/smithy-go/middleware"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

func main() {
	// A fake SQS server. It fails three times, then it succeeds.
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := hits.Add(1)
		fmt.Printf("server: hit %d, tag=%q\n", n, r.Header.Get("X-Team"))
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		if n <= 3 {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"__type":"InternalError","message":"try again"}`)
			return
		}
		fmt.Fprint(w, `{"QueueUrl":"https://example.com/q"}`)
	}))
	defer srv.Close()

	// The HTTP client has bounds on every phase of the request.
	httpClient := awshttp.NewBuildableClient().
		WithTimeout(10 * time.Second).
		WithDialerOptions(func(d *net.Dialer) { d.Timeout = time.Second }).
		WithTransportOptions(func(t *http.Transport) {
			t.ResponseHeaderTimeout = 2 * time.Second
			t.MaxIdleConnsPerHost = 32
		})

	client := sqs.New(sqs.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String(srv.URL),
		Credentials: aws.NewCredentialsCache(aws.CredentialsProviderFunc(
			func(context.Context) (aws.Credentials, error) {
				return aws.Credentials{AccessKeyID: "AKID", SecretAccessKey: "SECRET"}, nil
			})),
		HTTPClient: httpClient,
		// Give each client its own retryer. A shared retryer shares one token bucket.
		Retryer: retry.NewStandard(func(o *retry.StandardOptions) {
			o.MaxAttempts = 2
			// A fixed delay keeps this demo fast and stable. Use the default jitter in production.
			o.Backoff = retry.BackoffDelayerFunc(func(int, error) (time.Duration, error) {
				return 10 * time.Millisecond, nil
			})
		}),
		// This middleware runs one time for each operation, before the retry loop.
		APIOptions: []func(*middleware.Stack) error{addTeamHeader("payments")},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Call 1 uses the client settings: 2 attempts. It fails.
	_, err := client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String("jobs")})
	fmt.Println("call 1 failed:", err != nil)

	// Call 2 changes the attempts for this call only. The client stays the same.
	out, err := client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String("jobs")},
		func(o *sqs.Options) { o.RetryMaxAttempts = 3 })
	if err != nil {
		panic(err)
	}
	results, _ := retry.GetAttemptResults(out.ResultMetadata)
	fmt.Println("call 2 url:", aws.ToString(out.QueueUrl), "attempts:", len(results.Results))
}

// addTeamHeader returns an API option. The option adds a Build step middleware.
func addTeamHeader(team string) func(*middleware.Stack) error {
	return func(s *middleware.Stack) error {
		return s.Build.Add(middleware.BuildMiddlewareFunc("TeamHeader",
			func(ctx context.Context, in middleware.BuildInput, next middleware.BuildHandler) (
				middleware.BuildOutput, middleware.Metadata, error,
			) {
				if req, ok := in.Request.(*smithyhttp.Request); ok {
					req.Header.Set("X-Team", team)
				}
				return next.HandleBuild(ctx, in)
			}), middleware.After)
	}
}
```

Output:

<!-- output: wellbehaved -->
```text
server: hit 1, tag="payments"
server: hit 2, tag="payments"
call 1 failed: true
server: hit 3, tag="payments"
server: hit 4, tag="payments"
call 2 url: https://example.com/q attempts: 2
```

Call 2 uses three attempts, but the client still has two. The change was for call 2 only.

### 6. Accept a one-method interface in your code

For each operation, the SDK generates an interface with one method, and a compile-time guard:

```go
type ListQueuesAPIClient interface {
	ListQueues(context.Context, *ListQueuesInput, ...func(*Options)) (*ListQueuesOutput, error)
}

var _ ListQueuesAPIClient = (*Client)(nil)
```

Paginators and waiters accept this interface, not `*Client`. Do the same in your code. A fake for one method is small.
Example 14 in the section [Testing tricks](#testing-tricks) shows a fake with a paginator.


### 7. Change one step for one operation with `Swap`

`GetBucketLocation` returns XML that the normal S3 deserializer cannot read. The generated code does not add a special case to the deserializer.
It replaces the one middleware in the stack of that operation:

```go
_, err := stack.Deserialize.Swap("OperationDeserializer", &awsRestxml_deserializeOpGetBucketLocation_custom{})
```

The presign code uses the same method to put a presign middleware in the place of `Signing` (`aws-sdk-go-v2/service/s3/presign_post.go:271`).
A named stack lets you change one step and keep the others.

### 8. Add retry codes for one service only

STS can return `IDPCommunicationError` when the identity provider has a short failure. Only STS has this code, so only the STS client adds it:

<!-- sdk: aws-sdk-go-v2/service/sts/api_client.go:829 -->
```go
func finalizeSTSRetryableErrors(o *Options) {
	o.Retryer = retry.AddWithErrorCodes(o.Retryer, "IDPCommunicationError")
}
```

`AddWithErrorCodes` wraps the retryer and adds one check to the chain. Your own client can do the same for the error codes of each dependency.

### 9. Accept the output of one call as the input of the next

Route53 returns a hosted zone ID as `/hostedzone/Z123`, but its input fields want `Z123`. The client removes the prefix before it sends the request (`aws-sdk-go-v2/service/route53/api_client.go:846`).
Thus a caller can give the output of one call to the next call with no change. Be strict in what you send, but accept the forms that your own API returns.

### 10. Detect a loop of Lambda calls

In AWS Lambda, the SDK copies the environment variable `_X_AMZN_TRACE_ID` into the `X-Amzn-Trace-Id` header (`aws-sdk-go-v2/aws/middleware/recursion_detection.go:16`).
AWS can then see that a Lambda function calls a service that calls the same function again, and stop the loop.
The middleware does nothing outside Lambda, and it does not replace a header that the caller set.

## Resilience tricks

### 11. A retry budget is a circuit breaker for retries

The standard retryer has a token bucket with 500 tokens. In the default (legacy) mode:

- A retry costs 5 tokens. A retry after a timeout costs 10 tokens.
- An attempt that succeeds adds 1 token back.
- When the bucket is empty, the SDK stops the retries. It still sends the first attempt of each call.

So when a service is down, the retries stop after about 100 failures. The retries do not double the load on a service that is down.
This is the most useful trick in the SDK, and it is simple.

The token is a closure. The caller always calls `release(err)`. The closure gives the tokens back only after a success.

<!-- sdk: aws-sdk-go-v2/aws/retry/standard.go:296 -->
```go
	return releaseToken(fn).release, nil
}

func nopRelease(error) error { return nil }

type releaseToken func() error

func (f releaseToken) release(err error) error {
	if err != nil {
		return nil
	}

	return f()
}
```

The bucket checks the context first. A call that the caller cancelled does not take tokens.

<!-- sdk: aws-sdk-go-v2/aws/ratelimit/token_rate_limit.go:46 -->
```go
func (l *TokenRateLimit) GetToken(ctx context.Context, cost uint) (func() error, error) {
	select {
	case <-ctx.Done():
		return nil, canceledError{Err: ctx.Err()}
	default:
	}
	if avail, ok := l.bucket.Retrieve(cost); !ok {
		return nil, QuotaExceededError{Available: avail, Requested: cost}
	}

	return rateToken{
		tokenCost: cost,
		bucket:    l.bucket,
	}.release, nil
}
```

A new mode, with different costs, is available with `AWS_NEW_RETRIES_2026=true` (`aws-sdk-go-v2/aws/retry/standard.go:311`).
In that mode, a retry costs 14 tokens and a throttle retry costs 5.

Example 3 shows the budget with a small bucket:

Example 3, file `retrybudget/main.go`:

<!-- file: retrybudget/main.go -->
```go
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/ratelimit"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

func main() {
	var healthy atomic.Bool
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		if !healthy.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"__type":"InternalError","message":"down"}`)
			return
		}
		fmt.Fprint(w, `{"QueueUrl":"https://example.com/q"}`)
	}))
	defer srv.Close()

	// A small bucket: 10 tokens. Each retry costs 5 tokens.
	// A first attempt that succeeds adds 1 token back.
	bucket := ratelimit.NewTokenRateLimit(10)
	client := sqs.New(sqs.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String(srv.URL),
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: "AKID", SecretAccessKey: "SECRET"}, nil
		}),
		Retryer: retry.NewStandard(func(o *retry.StandardOptions) {
			o.MaxAttempts = 5
			o.RateLimiter = bucket
			o.RetryCost = 5
			o.Backoff = retry.BackoffDelayerFunc(func(int, error) (time.Duration, error) {
				return time.Millisecond, nil
			})
		}),
	})

	call := func(name string) {
		before := hits.Load()
		_, err := client.GetQueueUrl(context.Background(), &sqs.GetQueueUrlInput{QueueName: aws.String("q")})
		var quota ratelimit.QuotaExceededError
		state := "ok"
		switch {
		case errors.As(err, &quota):
			state = fmt.Sprintf("quota empty (have %d, need %d)", quota.Available, quota.Requested)
		case err != nil:
			state = "failed"
		}
		fmt.Printf("%-10s attempts: %d  %s\n", name, hits.Load()-before, state)
	}

	call("call 1") // 1 attempt + 2 retries use all 10 tokens, then it stops early
	call("call 2") // no tokens: no retry at all
	healthy.Store(true)
	call("call 3") // success on the first attempt adds 1 token back
}
```

Output:

<!-- output: retrybudget -->
```text
call 1     attempts: 3  quota empty (have 0, need 5)
call 2     attempts: 1  quota empty (have 0, need 5)
call 3     attempts: 1  ok
```

Call 2 makes only one attempt. The budget is for the client, not for one call.

### 12. Use full jitter, and apply the cap before the jitter

The backoff is `random * min(base * 2^attempt, max)`. The cap comes first, so the random part stays uniform in the capped range.
The legacy code calculates `log2(maxBackoff)` one time. Then the shift `1 << attempt` cannot overflow (`aws-sdk-go-v2/aws/retry/jitter_backoff.go:84`).
A throttle error uses a base of 1 second in the new mode. So the clients that the server throttles wait longer.

The random value comes from `crypto/rand`. It is an exact float in `[0, 1)`, with 53 random bits:

<!-- sdk: aws-sdk-go-v2/internal/rand/rand.go:17 -->
```go
var floatMaxBigInt = big.NewInt(1 << 53)

// Float64 returns a float64 read from an io.Reader source. The returned float will be between [0.0, 1.0).
func Float64(reader io.Reader) (float64, error) {
	bi, err := rand.Int(reader, floatMaxBigInt)
	if err != nil {
		return 0, fmt.Errorf("failed to read random value, %v", err)
	}

	return float64(bi.Int64()) / (1 << 53), nil
}
```

### 13. Classify errors with a chain of three-value checks

Each check returns `aws.TrueTernary`, `aws.FalseTernary` or `aws.UnknownTernary`.
The chain uses the first answer that is not "unknown". A new check can say "I do not know" and let the next check decide.
The checks use `errors.As` with an anonymous interface. Thus they do not import the concrete error types.

<!-- sdk: aws-sdk-go-v2/aws/retry/throttle_error.go:47 -->
```go
func (r ThrottleErrorCode) IsErrorThrottle(err error) aws.Ternary {
	var v interface{ ErrorCode() string }

	if !errors.As(err, &v) {
```

The first check in `DefaultRetryables` is `NoRetryCanceledError`. Thus a cancelled call never retries.
The second check reads `RetryableError() bool` from the error. Your own error can stop the retries or ask for a retry with this method.
Example 2 and example 13 use it.

### 14. Respect Retry-After, but put limits on it

The server can ask for a longer wait with `x-amz-retry-after`. The SDK uses the value only between the backoff and the backoff plus 5 seconds.
A bad or hostile value cannot stop the client for a long time.

<!-- sdk: aws-sdk-go-v2/aws/retry/middleware.go:545 -->
```go
	retryAfter := time.Duration(ms) * time.Millisecond
	minDuration := backoff
	maxDuration := 5*time.Second + backoff

	if retryAfter < minDuration {
		return minDuration
	}
	if retryAfter > maxDuration {
		return maxDuration
	}
	return retryAfter
}
```

### 15. Adaptive mode: TCP congestion control for API calls

`retry.NewAdaptiveMode()` adds a client-side rate limit. It uses the CUBIC curve from TCP (`aws-sdk-go-v2/aws/retry/adaptive_ratelimit.go:78`).

- A throttle response multiplies the send rate by 0.7.
- After the throttle, the rate grows on a cubic curve back to the old maximum.
- The rate can never be more than two times the measured rate.
- The limit does nothing until the first throttle. A healthy client has no extra latency.

The bucket does not use a goroutine or a ticker. It adds tokens from the elapsed time when a caller uses it:

<!-- sdk: aws-sdk-go-v2/aws/retry/adaptive_ratelimit.go:136 -->
```go
func (a *adaptiveRateLimit) tokenBucketRefill() {
	now := sdk.NowTime()
	if a.lastRefilled.IsZero() {
		a.lastRefilled = now
		return
	}

	fillAmount := secondsFloat64(now.Sub(a.lastRefilled)) * a.fillRate
	a.tokenBucket.Refund(fillAmount)
	a.lastRefilled = now
}
```

When the caller must wait, the code calculates the exact wait. It divides the number of tokens that it needs by the fill rate. Then it sleeps with the context. There is no busy loop.

### 16. Learn the clock skew from the responses

A signed request fails when the client clock is wrong. The SDK reads the `Date` header of each response.
It compares the server time with the midpoint of the round trip, not with the end. This removes half of the network delay from the error.

<!-- sdk: aws-sdk-go-v2/aws/middleware/middleware.go:109 -->
```go
func computeClockSkew(serverTime, requestAt, responseAt time.Time, hasAgeHeader bool) (time.Duration, bool) {
	if serverTime.IsZero() {
		return 0, false
	}

	if hasAgeHeader {
		return 0, false
	}

	elapsed := responseAt.Sub(requestAt)
	if elapsed > maxTrustedRequestDuration {
		return 0, false
	}

	midpoint := requestAt.Add(elapsed / 2)
	return serverTime.Sub(midpoint), true
}
```

An `Age` header means that a cache sent the response, so the date is old. The SDK ignores the value in that case.
The client keeps the skew in one `atomic.Int64` for all goroutines. After each operation it stores the new value, so the skew goes back to zero when the clocks agree again.
The SDK retries an auth error such as `SignatureDoesNotMatch` only when the skew is more than 4 minutes. Thus it does not retry a bad key.

### 17. A deadline for each silent gap, not only for the full request

`http.Client.Timeout` is a limit for the full request. It stops a large download that is slow but alive.
The SDK can also set a read deadline again before each `Read` on the connection. Then only a silent connection fails.

<!-- sdk: aws-sdk-go-v2/aws/transport/http/timeouts.go:22 -->
```go
func (c *deadlineConn) Read(p []byte) (int, error) {
	if err := c.Conn.SetReadDeadline(time.Now().Add(c.timeout)); err != nil {
		return 0, err
	}

	n, err := c.Conn.Read(p)
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return n, &ResponseTimeoutError{TimeoutDur: c.timeout}
	}

```

The SDK wraps `DialContext`, so each connection in the pool gets the deadline. HTTP/2 connections get it too.
The kernel enforces the deadline, so there is no goroutine for each read.
An older type, `timeout_read_closer.go`, starts a goroutine for each `Read`. After the timer fires, that goroutine can still write into the buffer of the caller. Do not copy that pattern.

The table in `internal/timeouts` uses `-1` to mean "no timeout" for S3, because S3 streams large bodies.
It reads the environment variable one time with `sync.OnceValue`:

<!-- sdk: aws-sdk-go-v2/internal/timeouts/timeouts.go:15 -->
```go
var enableFromEnv = sync.OnceValue(func() bool {
	return os.Getenv(enableReadTimeoutEnvVar) == "true"
})
```

Example 7:

Example 7, file `readtimeout/main.go`:

<!-- file: readtimeout/main.go -->
```go
package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"time"

	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
)

func main() {
	// slow: sends 10 small parts, 30 ms apart. It is slow, but it is alive.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for range 10 {
			fmt.Fprint(w, "part ")
			w.(http.Flusher).Flush()
			time.Sleep(30 * time.Millisecond)
		}
	}))
	defer slow.Close()

	// stuck: sends the headers, then stops for 2 seconds.
	stuck := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		time.Sleep(2 * time.Second)
	}))
	defer stuck.Close()

	total := awshttp.NewBuildableClient().WithTimeout(200 * time.Millisecond)    // limit for the full request
	idle := awshttp.NewBuildableClient().WithReadTimeout(100 * time.Millisecond) // limit for each silent gap

	get := func(c *awshttp.BuildableClient, url string) string {
		start := time.Now()
		resp, err := c.Do(must(http.NewRequest("GET", url, nil)))
		if err == nil {
			_, err = io.ReadAll(resp.Body)
			resp.Body.Close()
		}
		d := time.Since(start).Round(100 * time.Millisecond)
		if err != nil {
			return fmt.Sprintf("FAIL after ~%v", d)
		}
		return fmt.Sprintf("OK   after ~%v", d)
	}

	fmt.Println("total timeout, slow server: ", get(total, slow.URL))
	fmt.Println("idle timeout,  slow server: ", get(idle, slow.URL))
	fmt.Println("idle timeout,  stuck server:", get(idle, stuck.URL))
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
```

Output:

<!-- output: readtimeout -->
```text
total timeout, slow server:  FAIL after ~200ms
idle timeout,  slow server:  OK   after ~300ms
idle timeout,  stuck server: FAIL after ~100ms
```

### 18. A timeout for each attempt, inside the retry loop

The context of the call is a limit for all attempts together. If the first attempt hangs, it uses all of the time, and no retry can occur.
Put a timeout in a middleware after `Retry`. Then each attempt has its own deadline.

This has a catch. When the context of an attempt ends, smithy-go returns a `CanceledError`. The SDK never retries a `CanceledError`.
The solution: wrap the error in a type that has `CanceledError() bool { return false }`.
`errors.As` stops at the first match in the chain. So the retryer reads the method of the wrapper, not the method of the inner error.

Example 13, file `attempttimeout/main.go`:

<!-- file: attempttimeout/main.go -->
```go
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/smithy-go/middleware"
)

var errAttemptTimeout = errors.New("attempt timeout")

// attemptTimeoutError tells the retryer: this attempt was too slow, try again.
type attemptTimeoutError struct{ err error }

func (e *attemptTimeoutError) Error() string        { return "attempt timed out: " + e.err.Error() }
func (e *attemptTimeoutError) Unwrap() error        { return e.err }
func (e *attemptTimeoutError) RetryableError() bool { return true }

// CanceledError hides the CanceledError of the inner error. errors.As stops at
// the first match, so the retryer reads this method, not the inner one.
func (e *attemptTimeoutError) CanceledError() bool { return false }

// WithAttemptTimeout gives each attempt its own deadline.
// Do not use it for operations that stream the response body (for example S3 GetObject):
// the cancel runs before the caller reads the body.
func WithAttemptTimeout(d time.Duration) func(*middleware.Stack) error {
	mw := middleware.FinalizeMiddlewareFunc("AttemptTimeout",
		func(ctx context.Context, in middleware.FinalizeInput, next middleware.FinalizeHandler) (
			middleware.FinalizeOutput, middleware.Metadata, error,
		) {
			actx, cancel := context.WithTimeoutCause(ctx, d, errAttemptTimeout)
			defer cancel()
			out, md, err := next.HandleFinalize(actx, in)
			// The SDK sees a done context as "canceled" and does not retry.
			// If only our attempt deadline fired, and the caller's ctx is fine, make it retryable.
			if err != nil && ctx.Err() == nil && errors.Is(context.Cause(actx), errAttemptTimeout) {
				err = &attemptTimeoutError{err}
			}
			return out, md, err
		})
	return func(s *middleware.Stack) error {
		return s.Finalize.Insert(mw, "Retry", middleware.After)
	}
}

func main() {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			select { // the first request hangs
			case <-time.After(3 * time.Second):
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		fmt.Fprint(w, `{"QueueUrl":"https://example.com/q"}`)
	}))
	defer srv.Close()

	newClient := func(opts ...func(*middleware.Stack) error) *sqs.Client {
		return sqs.New(sqs.Options{
			Region: "us-east-1", BaseEndpoint: aws.String(srv.URL),
			Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
				return aws.Credentials{AccessKeyID: "AKID", SecretAccessKey: "SECRET"}, nil
			}),
			Retryer: retry.NewStandard(func(o *retry.StandardOptions) {
				o.Backoff = retry.BackoffDelayerFunc(func(int, error) (time.Duration, error) { return 0, nil })
			}),
			APIOptions: opts,
		})
	}

	for _, tc := range []struct {
		name   string
		client *sqs.Client
	}{
		{"one deadline for the call ", newClient()},
		{"deadline for each attempt ", newClient(WithAttemptTimeout(200 * time.Millisecond))},
	} {
		hits.Store(0)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		start := time.Now()
		_, err := tc.client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String("q")})
		cancel()
		fmt.Printf("%s ok=%-5v attempts=%d time=~%v\n", tc.name, err == nil, hits.Load(),
			time.Since(start).Round(100*time.Millisecond))
	}
}
```

Output:

<!-- output: attempttimeout -->
```text
one deadline for the call  ok=false attempts=1 time=~1s
deadline for each attempt  ok=true  attempts=2 time=~200ms
```

Do not use this middleware for an operation that streams its response body, for example S3 `GetObject`. The `cancel` runs before the caller reads the body.

### 19. Static stability: use old credentials when the source is down

When IMDS (the EC2 metadata service) is down, `ec2rolecreds` does not fail. It keeps the old credentials for 5 to 15 more minutes, with a random value.
With the random value, the hosts do not try again at the same moment.

<!-- sdk: aws-sdk-go-v2/credentials/ec2rolecreds/provider.go:134 -->
```go
	// Random distribution of [5,15) minutes.
	expireOffset := time.Duration(randFloat64*float64(10*time.Minute)) + 5*time.Minute
	newCreds.Expires = sdk.NowTime().Add(expireOffset)
```

The credential cache finds this behavior through an optional interface, `HandleFailRefreshCredentialsCacheStrategy`.
The cache does not change, and each provider can add the behavior.
The AWS keys often stay valid for some time after the refresh time, so the old keys still work.

Example 10, file `staticstable/main.go`:

<!-- file: staticstable/main.go -->
```go
package main

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
)

// stableProvider wraps a source. If a refresh fails and old keys exist,
// it keeps the old keys for a short random time. This is what
// ec2rolecreds does when IMDS is down: it adds 5 to 15 minutes.
type stableProvider struct {
	source    aws.CredentialsProvider
	minExtend time.Duration
	maxExtend time.Duration
}

func (p stableProvider) Retrieve(ctx context.Context) (aws.Credentials, error) {
	return p.source.Retrieve(ctx)
}

// HandleFailToRefresh is an optional method. aws.CredentialsCache finds it with a type assertion.
func (p stableProvider) HandleFailToRefresh(ctx context.Context, prev aws.Credentials, err error) (aws.Credentials, error) {
	if !prev.HasKeys() {
		return aws.Credentials{}, err // nothing to fall back to
	}
	// Random extension: a fleet of hosts does not retry at the same moment.
	extend := p.minExtend + rand.N(p.maxExtend-p.minExtend)
	prev.Expires = time.Now().Add(extend)
	return prev, nil
}

func main() {
	var down atomic.Bool
	var calls atomic.Int32
	source := aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		calls.Add(1)
		if down.Load() {
			return aws.Credentials{}, errors.New("IMDS: connection refused")
		}
		return aws.Credentials{AccessKeyID: "AKID-1", SecretAccessKey: "s",
			CanExpire: true, Expires: time.Now().Add(50 * time.Millisecond)}, nil
	})

	plain := aws.NewCredentialsCache(source)
	stable := aws.NewCredentialsCache(stableProvider{source, 200 * time.Millisecond, 400 * time.Millisecond})

	ctx := context.Background()
	plain.Retrieve(ctx)
	stable.Retrieve(ctx)

	down.Store(true)                  // the credential source goes down
	time.Sleep(80 * time.Millisecond) // and the keys expire

	_, err := plain.Retrieve(ctx)
	fmt.Println("plain cache: ", err)

	c, err := stable.Retrieve(ctx)
	fmt.Println("stable cache:", c.AccessKeyID, err)

	before := calls.Load()
	stable.Retrieve(ctx)
	fmt.Println("source calls during the extension:", calls.Load()-before)
}
```

Output:

<!-- output: staticstable -->
```text
plain cache:  failed to refresh cached credentials, IMDS: connection refused
stable cache: AKID-1 <nil>
source calls during the extension: 0
```

### 20. Fail fast on a host that is not EC2

On a laptop, IMDS does not exist. The IMDS client uses a dial timeout of 250 ms and a response header timeout of 500 ms (`aws-sdk-go-v2/feature/ec2/imds/api_client.go:277`).
Thus the credential chain moves to the next source quickly. A slow fallback is a slow start for each program.

The IMDS client also adds a 5 second timeout, but only when the caller has no deadline:

<!-- sdk: aws-sdk-go-v2/feature/ec2/imds/request_middleware.go:279 -->
```go
	if _, ok := ctx.Deadline(); !ok && m.DefaultTimeout != 0 {
		var cancelFn func()
		ctx, cancelFn = context.WithTimeout(ctx, m.DefaultTimeout)
		defer cancelFn()
	}
```

This is a good rule for each library: add a default deadline, but never replace the deadline of the caller.

### 21. Drain the body before you close it

If you close a response body before EOF, the transport cannot use the connection again.
smithy-go reads the rest of the body into `io.Discard`, then closes it (`smithy-go/transport/http/middleware_close_response_body.go:15`).
It does not do this for a streaming response that succeeded. The caller owns that body.

### 22. Pin the version during a multi-part download

The transfer manager sends the `ETag` of the first part as `If-Match` for all the other parts (`aws-sdk-go-v2/feature/s3/transfermanager/api_op_DownloadObject.go:745`).
If the object changes during the download, the server returns 412. The download fails. It does not join bytes from two versions.
Example 11 shows this.

### 23. After a failure, abort on a new context, and report the root cause

When an upload fails, the transfer manager aborts the multi-part upload. The context of the caller is often already cancelled at that time.
The old `manager` package sends the abort with that cancelled context and ignores the error. Thus parts stay on S3, and you pay for them.
The new `transfermanager` uses a new context with a time limit, `freshContext` (`aws-sdk-go-v2/feature/s3/transfermanager/api_op_UploadObject.go:1198`).

It also keeps the correct error. A "context canceled" error is usually a result of a different error, so a real error replaces it:

<!-- sdk: aws-sdk-go-v2/feature/s3/transfermanager/api_op_UploadObject.go:1189 -->
```go
	if u.err == nil || (isCancellationError(u.err) && !isCancellationError(e)) {
		u.err = e
	}
```


### 24. If you cannot hash the body, sign without the hash

SigV4 signs a SHA-256 of the body. The code cannot read a body twice if the body cannot seek, for example a pipe.
The auth scheme does not fail in that case. It signs the value `UNSIGNED-PAYLOAD` (`smithy-go/aws-http-auth-schemes/internal/payloadhash/payloadhash.go:23`). TLS still protects the body.
Fall back to a weaker mode that the server accepts. Do not fail the call.

## Stack a circuit breaker and a retry

A retry and a circuit breaker solve two different problems.
The retry helps with a short failure of one request. The breaker helps with a long failure of a dependency.
The order of the two is important.

**Breaker outside the retry loop.** The breaker sees one result for each call. It opens late, because it counts calls, not attempts.
While the breaker stays closed, a single call can still send `MaxAttempts` requests to a dependency that is down.

**Breaker inside the retry loop.** The breaker sees each attempt. It opens after the attempts fail, and it also blocks the retries.
This is the better order for an AWS client. In smithy-go, put the breaker in the Finalize step, after `Retry`.

Follow these rules:

1. Put the breaker after `Retry` and before `Signing`. Then a blocked attempt does not sign or send.
2. Make the error of an open breaker not retryable: `RetryableError() bool { return false }`. Then the retry loop stops at once.
3. Count only the faults of the server: 5xx responses and network errors. A 4xx error is a fault of the caller. It must not open the breaker.
4. Do not count a cancelled context.
5. Use one breaker for each dependency (host or service). Do not make a breaker for each call.
6. Keep the SDK retry budget. The budget limits retries across the full client. The breaker blocks all attempts to one dependency.

The SDK has no breaker. The retry budget does part of the work, but the first attempt of each call still goes to the server.

Example 2, file `breaker/main.go`:

<!-- file: breaker/main.go -->
```go
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/smithy-go/middleware"
)

// ErrOpen tells the caller that the breaker blocked the attempt.
// RetryableError returns false. The SDK retryer reads this method and stops.
type ErrOpen struct{}

func (ErrOpen) Error() string        { return "circuit breaker is open" }
func (ErrOpen) RetryableError() bool { return false }

// Breaker counts failed attempts. It opens after Threshold failures in a row.
// After Cooldown, it lets one probe attempt through (half-open).
type Breaker struct {
	Threshold int
	Cooldown  time.Duration

	mu       sync.Mutex
	fails    int
	openedAt time.Time
	probing  bool
}

func (b *Breaker) allow() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.fails < b.Threshold {
		return nil // closed
	}
	if time.Since(b.openedAt) < b.Cooldown || b.probing {
		return ErrOpen{} // open, or a probe is already in flight
	}
	b.probing = true // half-open: this attempt is the probe
	return nil
}

func (b *Breaker) record(failed bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.probing = false
	if !failed {
		b.fails = 0
		return
	}
	b.fails++
	if b.fails >= b.Threshold {
		b.openedAt = time.Now()
	}
}

// ID makes the breaker a named middleware in the stack.
func (b *Breaker) ID() string { return "CircuitBreaker" }

// HandleFinalize runs one time for each attempt, because it is after "Retry".
func (b *Breaker) HandleFinalize(ctx context.Context, in middleware.FinalizeInput, next middleware.FinalizeHandler) (
	middleware.FinalizeOutput, middleware.Metadata, error,
) {
	if err := b.allow(); err != nil {
		return middleware.FinalizeOutput{}, middleware.Metadata{}, err
	}
	out, md, err := next.HandleFinalize(ctx, in)
	b.record(isServerFault(err))
	return out, md, err
}

// isServerFault counts 5xx responses and network errors. 4xx errors are the
// caller's fault, so they do not open the breaker.
func isServerFault(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	var re *awshttp.ResponseError
	if errors.As(err, &re) {
		return re.HTTPStatusCode() >= 500
	}
	return true
}

// WithBreaker puts the breaker inside the retry loop, before signing.
func WithBreaker(b *Breaker) func(*middleware.Stack) error {
	return func(s *middleware.Stack) error {
		return s.Finalize.Insert(b, "Retry", middleware.After)
	}
}

func main() {
	var healthy atomic.Bool
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		if !healthy.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprint(w, `{"__type":"ServiceUnavailable","message":"down"}`)
			return
		}
		fmt.Fprint(w, `{"QueueUrl":"https://example.com/q"}`)
	}))
	defer srv.Close()

	// Share one breaker for each downstream host, not for each call.
	br := &Breaker{Threshold: 3, Cooldown: 50 * time.Millisecond}
	client := sqs.New(sqs.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String(srv.URL),
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: "AKID", SecretAccessKey: "SECRET"}, nil
		}),
		Retryer: retry.NewStandard(func(o *retry.StandardOptions) {
			o.MaxAttempts = 3
			o.Backoff = retry.BackoffDelayerFunc(func(int, error) (time.Duration, error) {
				return time.Millisecond, nil
			})
		}),
		APIOptions: []func(*middleware.Stack) error{WithBreaker(br)},
	})

	call := func(name string) {
		before := hits.Load()
		_, err := client.GetQueueUrl(context.Background(), &sqs.GetQueueUrlInput{QueueName: aws.String("q")})
		state := "ok"
		switch {
		case errors.As(err, new(ErrOpen)):
			state = "blocked by breaker"
		case err != nil:
			state = "failed"
		}
		fmt.Printf("%-28s %-20s server hits: %d\n", name, state, hits.Load()-before)
	}

	call("1: server down")  // 3 attempts fail, breaker opens
	call("2: breaker open") // no attempt reaches the server
	time.Sleep(60 * time.Millisecond)
	call("3: half-open probe fails") // 1 probe, it fails, breaker opens again
	healthy.Store(true)
	call("4: still open") // cooldown is not over
	time.Sleep(60 * time.Millisecond)
	call("5: half-open probe succeeds") // probe works, breaker closes
	call("6: closed")
}
```

Output:

<!-- output: breaker -->
```text
1: server down               failed               server hits: 3
2: breaker open              blocked by breaker   server hits: 0
3: half-open probe fails     blocked by breaker   server hits: 1
4: still open                blocked by breaker   server hits: 0
5: half-open probe succeeds  ok                   server hits: 1
6: closed                    ok                   server hits: 1
```

Look at call 3. The breaker lets one probe go through, and the probe gets a 503. The retryer then tries again.
The breaker blocks that second attempt with `ErrOpen`, so the loop stops. The server sees only one request.

## Concurrency tricks

### 25. Share one fetch, but let each caller leave on its own context

The credential cache uses `singleflight.DoChan`, not `Do`. Each caller waits on the channel and on its own `ctx.Done()`.
The shared fetch runs on a context without a cancel. Thus the first caller cannot cancel the fetch for the others.

<!-- sdk: aws-sdk-go-v2/aws/credential_cache.go:98 -->
```go
func (p *CredentialsCache) Retrieve(ctx context.Context) (Credentials, error) {
	if creds, ok := p.getCreds(); ok && !creds.Expired() {
		return creds, nil
	}

	resCh := p.sf.DoChan("", func() (interface{}, error) {
		return p.singleRetrieve(&suppressedContext{ctx})
	})
	select {
	case res := <-resCh:
		return res.Val.(Credentials), res.Err
	case <-ctx.Done():
		return Credentials{}, &RequestCanceledError{Err: ctx.Err()}
	}
}
```

`suppressedContext` keeps the values of the context, but `Done`, `Deadline` and `Err` return nothing.
Since Go 1.21, `context.WithoutCancel` does the same. Add your own upper limit with `context.WithTimeout`, because a fetch without a limit can run forever.
The S3 Express credential provider does not do this. It passes the context of the request into the shared fetch (`aws-sdk-go-v2/service/s3/express_default.go:114`).
If the first caller leaves, all the callers that wait on the same fetch get the error.

Example 6 shows the bug and the fix in plain Go:

Example 6, file `sharedfetch/main.go`:

<!-- file: sharedfetch/main.go -->
```go
package main

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/sync/singleflight"
)

// slowFetch stands for a token or config fetch. It respects ctx.
func slowFetch(ctx context.Context) (string, error) {
	select {
	case <-time.After(50 * time.Millisecond):
		return "token-123", nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Fetcher shares one fetch between all callers that arrive at the same time.
type Fetcher struct {
	sf     singleflight.Group
	detach bool // true: the good way. false: the bug in s3 express_default.go.
}

func (f *Fetcher) Get(ctx context.Context) (string, error) {
	ch := f.sf.DoChan("token", func() (any, error) {
		workCtx := ctx
		if f.detach {
			// Keep the values, drop the cancel. Then add our own upper limit.
			var cancel context.CancelFunc
			workCtx, cancel = context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
		}
		return slowFetch(workCtx)
	})
	// Each caller waits on its own ctx. A caller can leave; the fetch continues.
	select {
	case r := <-ch:
		if r.Err != nil {
			return "", r.Err
		}
		return r.Val.(string), nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func run(detach bool) {
	f := &Fetcher{detach: detach}
	impatient, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	first := make(chan error, 1) // buffer 1: the goroutine never blocks on send
	go func() { _, err := f.Get(impatient); first <- err }()
	time.Sleep(time.Millisecond) // let the first caller start the shared fetch

	v, err := f.Get(context.Background()) // a patient caller joins the same fetch
	fmt.Printf("detach=%-5v first caller: %v | patient caller: %q err=%v\n", detach, <-first, v, err)
}

func main() {
	run(false) // the patient caller fails because the first caller left
	run(true)  // the patient caller gets the token
}
```

Output:

<!-- output: sharedfetch -->
```text
detach=false first caller: context deadline exceeded | patient caller: "" err=context deadline exceeded
detach=true  first caller: context deadline exceeded | patient caller: "token-123" err=<nil>
```

Example 5 shows the SDK cache:

Example 5, file `credcache/main.go`:

<!-- file: credcache/main.go -->
```go
package main

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
)

func main() {
	var fetches atomic.Int32
	slowSource := aws.CredentialsProviderFunc(func(ctx context.Context) (aws.Credentials, error) {
		fetches.Add(1)
		time.Sleep(50 * time.Millisecond) // a slow STS or IMDS call
		return aws.Credentials{
			AccessKeyID: "AKID", SecretAccessKey: "SECRET",
			CanExpire: true, Expires: time.Now().Add(time.Hour),
		}, nil
	})

	cache := aws.NewCredentialsCache(slowSource, func(o *aws.CredentialsCacheOptions) {
		o.ExpiryWindow = 5 * time.Minute // refresh 5 minutes early
		o.ExpiryWindowJitterFrac = 0.5   // each process picks a point in the last 2.5 to 5 minutes
	})

	// 100 goroutines ask at the same time. Only one fetch happens.
	var wg sync.WaitGroup
	for range 100 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := cache.Retrieve(context.Background()); err != nil {
				panic(err)
			}
		}()
	}
	wg.Wait()
	fmt.Println("fetches after 100 concurrent calls:", fetches.Load())

	// A caller with a short deadline gives up. The shared fetch continues for the others.
	cache.Invalidate()
	short, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err := cache.Retrieve(short)
	fmt.Println("short caller error:", err != nil)
	creds, err := cache.Retrieve(context.Background())
	fmt.Println("next caller ok:", err == nil, "fetches:", fetches.Load())

	// Expires is moved earlier by the window, so the cache refreshes before AWS rejects the keys.
	early := time.Until(creds.Expires).Round(time.Minute)
	fmt.Println("refresh in 55..58 minutes:", early >= 55*time.Minute && early <= 58*time.Minute)
}
```

Output:

<!-- output: credcache -->
```text
fetches after 100 concurrent calls: 1
short caller error: true
next caller ok: true fetches: 2
refresh in 55..58 minutes: true
```


### 26. A new body wrapper for each attempt

Before each attempt, smithy-go wraps the stream of the caller in a new `SafeReadCloser(io.NopCloser(stream))` (`smithy-go/transport/http/request.go:186`).
`net/http` closes the request body after a send. With this wrapper, the close reaches only the wrapper, so the SDK can rewind the stream of the caller for the retry.
A goroutine of the transport can still hold the body of the old attempt. After the close, that body returns `io.EOF`, so the old goroutine cannot read the bytes of the new attempt.

### 27. Register no-op middlewares under the standard IDs

The IMDS client does not sign and does not resolve endpoints with rules. But it adds empty middlewares with the IDs `Signing`, `GetIdentity`, `ResolveAuthScheme` and `ResolveEndpointV2` (`aws-sdk-go-v2/feature/ec2/imds/auth.go:8`).
A user option that inserts "before `Signing`" then works on IMDS too. Without the empty middlewares, the insert would fail because the ID does not exist.
If other code puts middleware relative to your IDs, keep the IDs, also when the step does nothing.

### 28. A detached context that drops its values after the parent ends

`smithy-go/context.WithSuppressCancel` gives a context that ignores the cancel of its parent. But after the parent ends, `Value` returns `nil`, unless you ask for the values with `WithPreserveExpiredValues` (`smithy-go/context/suppress_expired.go:31`).
Background work after a request thus cannot read values that belonged to that request, for example a request ID or a span. `context.WithoutCancel` in the standard library always keeps the values.

### 29. Move the expiry time earlier by a random amount

`ExpiryWindow` makes the cache refresh before the real expiry. `ExpiryWindowJitterFrac` moves each process to a random point in that window.
Thus a fleet that started at the same time does not refresh at the same time.

<!-- sdk: aws-sdk-go-v2/aws/credential_cache.go:143 -->
```go
		var jitter time.Duration
		if p.options.ExpiryWindowJitterFrac > 0 {
			jitter = time.Duration(randFloat64 *
				p.options.ExpiryWindowJitterFrac * float64(p.options.ExpiryWindow))
		}

		newCreds, err = adjustExpiresBy(newCreds, -(p.options.ExpiryWindow - jitter))
```

### 30. Compare an expiry time with the wall clock

The server sends an expiry time. That time is a wall clock time.
A `time.Time` from `time.Now()` also has a monotonic clock part. `Round(0)` removes that part, so the comparison uses the same clock as the server.

<!-- sdk: aws-sdk-go-v2/aws/credentials.go:153 -->
```go
func (v Credentials) Expired() bool {
	if v.CanExpire {
		// Calling Round(0) on the current time will truncate the monotonic
		// reading only. Ensures credential expiry time is always based on
		// reported wall-clock time.
		return !v.Expires.After(sdk.NowTime().Round(0))
	}
```

After a laptop sleeps, the monotonic clock and the wall clock are different. Without `Round(0)`, the keys can look valid after they expire.

### 31. Invalidate an `atomic.Value` with a typed nil

`atomic.Value` must always hold the same concrete type. Thus the cache stores `*Credentials`.
To clear the cache, it stores `(*Credentials)(nil)`. The reader treats a nil pointer as empty. The read path needs no lock (`aws-sdk-go-v2/aws/credential_cache.go:161`).

### 32. The SDK singleflight knows the difference between panic and `Goexit`

`internal/sync/singleflight` is a copy of the `x/sync` version. It uses two `defer` statements to find which of the two events stopped the function.
After a panic, it panics again in a new goroutine. Thus the callers that wait on `DoChan` do not wait forever.

<!-- sdk: aws-sdk-go-v2/internal/sync/singleflight/singleflight.go:137 -->
```go
func (g *Group) doCall(c *call, key string, fn func() (interface{}, error)) {
	normalReturn := false
	recovered := false

	// use double-defer to distinguish panic from runtime.Goexit,
	// more details see https://golang.org/cl/134395
	defer func() {
		// the given function invoked runtime.Goexit
		if !normalReturn && !recovered {
			c.err = errGoexit
```

`Forget` sets a `forgotten` flag on the old call. Thus the old call cannot delete the map entry of a newer call with the same key.

### 33. Give a result channel a buffer of 1

When a caller leaves on `ctx.Done()`, nobody reads the channel. With a buffer of 1, the goroutine can still send its result and stop.
Without the buffer, the goroutine leaks. The SDK uses `make(chan Result, 1)` for each `DoChan` caller.
Example 6 uses the same rule for `first := make(chan error, 1)`.

### 34. A bounded buffer pool is a channel

The transfer manager puts all its buffers into a buffered channel. `Get` blocks until a buffer is free. This gives back-pressure with no extra code.
The old `manager` pool drops a buffer in `Put` when the channel is full. Thus `Put` can never block, even when the pool gets smaller.

<!-- sdk: aws-sdk-go-v2/feature/s3/manager/pool.go:120 -->
```go
	select {
	case p.slices <- bs:
		p.notifyCapacity()
	default:
		// If the new channel when attempting to add the slice then we drop the slice.
		// The logic here is to prevent a deadlock situation if channel is already at max capacity.
```

smithy-go does not put a large buffer back into its `sync.Pool`. One large response must not keep 10 MB in the pool forever:

<!-- sdk: smithy-go/internal/sync/buffer_pool.go:47 -->
```go
func (p *BufferPool) Put(buf *bytes.Buffer) {
	if buf.Cap() <= maxBufferSize {
		buf.Reset()
		p.pool.Put(buf)
	}
}
```

Put `*[]byte` into a `sync.Pool`, not `[]byte`. A slice value in an `any` causes one allocation for each `Put`.
`feature/s3/manager/read_seeker_write_to.go:41` stores `[]byte`. `feature/s3/manager/pool.go` stores `*[]byte`.

### 35. Write the parts out of order into an `io.WriterAt`

The downloader writes each part at its own offset. The parts can finish in any order, and no lock is necessary for the order.
The SDK has its own type for this, `dlchunk` (`aws-sdk-go-v2/feature/s3/manager/download.go:564`).
Since Go 1.20, `io.NewOffsetWriter` does the same. A file (`*os.File`) is an `io.WriterAt`.

For uploads, the SDK uses `io.NewSectionReader` on a body that is an `io.ReaderAt`. Each part reads the same file at its own offset, with no copy (`aws-sdk-go-v2/feature/s3/manager/upload.go:480`).

Example 11 is a parallel ranged download. It has a worker pool, a buffer pool, the root cause error, a cancel of the other workers, and the `If-Match` pin:

Example 11, file `parts/main.go`:

<!-- file: parts/main.go -->
```go
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var errChanged = errors.New("object changed during download")

// download gets url in parts of partSize bytes, with n workers, into dst.
func download(ctx context.Context, url string, dst io.WriterAt, partSize int64, n int) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	// Part 0 tells us the total size and the ETag.
	total, etag, err := getPart(ctx, url, "", 0, partSize, dst, make([]byte, 32<<10))
	if err != nil {
		return err
	}

	// A bounded buffer pool: a channel of buffers. Get blocks; this is back-pressure.
	pool := make(chan []byte, n)
	for range n {
		pool <- make([]byte, 32<<10)
	}

	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		firstErr error
	)
	setErr := func(err error) {
		mu.Lock()
		defer mu.Unlock()
		// Keep the root cause. A cancel error is only a result of an earlier error.
		if firstErr == nil || (errors.Is(firstErr, context.Canceled) && !errors.Is(err, context.Canceled)) {
			firstErr = err
		}
		cancel(err) // stop the other workers
	}

	jobs := make(chan int64)
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for start := range jobs {
				buf := <-pool
				_, _, err := getPart(ctx, url, etag, start, partSize, dst, buf)
				pool <- buf // always give the buffer back, also after an error
				if err != nil {
					setErr(err)
				}
			}
		}()
	}
	for start := partSize; start < total && ctx.Err() == nil; start += partSize {
		jobs <- start
	}
	close(jobs)
	wg.Wait()
	return firstErr
}

// getPart gets one byte range and writes it at its own offset in dst.
func getPart(ctx context.Context, url, etag string, start, size int64, dst io.WriterAt, buf []byte) (int64, string, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, start+size-1))
	if etag != "" {
		req.Header.Set("If-Match", etag) // pin the version we started with
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusPreconditionFailed {
		return 0, "", errChanged
	}
	if resp.StatusCode != http.StatusPartialContent {
		return 0, "", fmt.Errorf("part at %d: status %d", start, resp.StatusCode)
	}
	// Out-of-order writes are safe: each part has its own offset.
	if _, err := io.CopyBuffer(io.NewOffsetWriter(dst, start), resp.Body, buf); err != nil {
		return 0, "", err
	}
	// Content-Range is "bytes 0-99/1000". The number after "/" is the total size.
	cr := resp.Header.Get("Content-Range")
	total, _ := strconv.ParseInt(cr[strings.LastIndex(cr, "/")+1:], 10, 64)
	return total, resp.Header.Get("ETag"), nil
}

// discardAt drops all bytes. The SDK test kit has the same type: awstesting.DiscardAt.
type discardAt struct{}

func (discardAt) WriteAt(p []byte, _ int64) (int, error) { return len(p), nil }

func main() {
	v1 := bytes.Repeat([]byte("0123456789abcdef"), 64<<10) // 1 MiB
	var version atomic.Int32
	version.Store(1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := v1
		if version.Load() == 2 {
			body = bytes.ToUpper(v1)
		}
		w.Header().Set("ETag", fmt.Sprintf(`"v%d"`, version.Load()))
		// ServeContent handles Range and If-Match for us.
		http.ServeContent(w, r, "obj", time.Time{}, bytes.NewReader(body))
	}))
	defer srv.Close()

	f, _ := os.CreateTemp("", "part-*")
	defer os.Remove(f.Name())
	err := download(context.Background(), srv.URL, f, 100<<10, 4)
	got, _ := os.ReadFile(f.Name())
	fmt.Printf("run 1: err=%v same bytes=%v\n", err, sha256.Sum256(got) == sha256.Sum256(v1))

	// The object changes after part 0. The pinned ETag makes the next parts fail.
	slow := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		srv.Config.Handler.ServeHTTP(w, r)
		version.Store(2)
	})
	srv2 := httptest.NewServer(slow)
	defer srv2.Close()
	version.Store(1)
	err = download(context.Background(), srv2.URL, discardAt{}, 100<<10, 4)
	fmt.Printf("run 2: err=%v\n", err)
}
```

Output:

<!-- output: parts -->
```text
run 1: err=<nil> same bytes=true
run 2: err=object changed during download
```

The program also passes with `go run -race`.

### 36. Do not multiply the concurrency

`DownloadDirectory` does not give its options to the download of each object. The comment says why:

<!-- sdk: aws-sdk-go-v2/feature/s3/transfermanager/api_op_DownloadDirectory.go:316 -->
```go
	// Options are not forwarded here: d.options.Concurrency is the object worker
	// count, and reusing it for parts would put workers^2 requests in flight.
```

Watch for this when you put one worker pool inside a different worker pool.

### 37. A fetch in the background after the cached value gets old

The bearer token cache gives the cached token at once when it is near the expiry. It also starts one refresh in the background.
The refresh uses `DoChan` with a fixed key, and nobody reads the channel. Thus many callers start only one refresh (`smithy-go/auth/bearer/token_cache.go:137`).
This is "stale while revalidate" in about 20 lines.

### 38. Use one lock order when a lock is inside a different lock

The adaptive limiter has a lock, and its token bucket has a different lock.
The code always takes the outer lock first. It never takes the outer lock while it holds the inner lock. Thus the two locks cannot deadlock (`aws-sdk-go-v2/aws/retry/adaptive_ratelimit.go:57`).



### 39. An end function that you can call two times

The metric timer returns a closure with an `ended` flag (`aws-sdk-go-v2/internal/kitchensinktestcborlegacy/api_client.go:93`). The code calls it early on the main path, and also with `defer` for the error paths. Only the first call records the metric.
When metrics are off, the function returns a no-op closure, so the call sites do not need an `if`.

### 40. A channel of one that keeps only the latest value

```go
select {
case <-prc: // remove the old value, if there is one
default:
}
prc <- v // the buffer is now empty, so this does not block
```

The event stream code uses this so that each retry replaces the partial result of the previous attempt (`aws-sdk-go-v2/internal/kitchensinktestrestjson/eventstream.go:136`). It is safe with one sender. With more senders, use a mutex.

### 41. Put a time limit on a `Close` that can block

The event stream writer runs `Close()` in a goroutine that closes a `done` channel. The caller waits on `done` or on a 1 second timer, and then continues (`aws-sdk-go-v2/internal/protocoltest/awsrestjson/api_op_DuplexStreamWithInitialMessages.go:262`).
A peer that does not answer cannot stop the shutdown of the client.

### 42. Wake all waiters: close a channel

The `manager` buffer pool keeps a `capacityChange` channel. A waiter copies the channel while it holds the read lock, then unlocks and waits on it. `ModifyCapacity` closes the channel to wake all waiters, and makes a new one (`aws-sdk-go-v2/feature/s3/manager/pool.go:98`).
The waiter does not hold the lock while it waits, so a writer that wants the lock cannot deadlock with it. This is a simple broadcast without `sync.Cond`.

### 43. Round-robin over the IP addresses of one host

The transfer manager caches the IP addresses of the S3 host. Each cache entry keeps its own index, and each lookup returns the next address (`aws-sdk-go-v2/feature/s3/transfermanager/dns_cache.go:44`).
New connections thus go to many S3 front ends, not to the one address that the resolver returns first. This gives more throughput for large parallel transfers.

### 44. Lazy slots with atomic pointers, and a slow path that does not inline

Each smithy-go `Schema` has a fixed array of `unsafe.Pointer` slots, one slot for each codec. A codec stores its own cache for the schema in its slot.
There is no map and no lock:

<!-- sdk: smithy-go/schema_ext.go:25 -->
```go
func SchemaExtension[T any](s *Schema, id ExtensionID, build func(*Schema) *T) *T {
	p := atomic.LoadPointer(&s.ext[id])
	if p != nil {
		return (*T)(p)
	}
	return computeSchemaExtension(s, id, build)
}

//go:noinline
func computeSchemaExtension[T any](s *Schema, id ExtensionID, build func(*Schema) *T) *T {
	v := build(s)
	atomic.StorePointer(&s.ext[id], unsafe.Pointer(v))
	return v
}
```

Two goroutines can both build the value. The last store wins. This is safe, because `build` always gives the same result.
The slow path has `//go:noinline`, so the fast path is small. `go build -gcflags=-m` reports `can inline smithy.SchemaExtension[...]` at each call site.
`atomic.Pointer[T]` cannot hold a different `T` in each slot, so the code uses `unsafe.Pointer` and a generic wrapper.

### 45. A generic factory in a map

The type registry maps a shape ID to a function that makes a new value:

<!-- sdk: smithy-go/type_registry.go:16 -->
```go
func RegistryEntry[T any](schema *Schema) *TypeRegistryEntry {
	return &TypeRegistryEntry{
		Schema: schema,
		New: func() any {
			return new(T)
		},
	}
}
```

The deserializer reads an error code from the wire. It finds the entry and calls `New()` to get a `*ThrottlingException`, with no `switch` for each error.
The generic function makes the closure, and the map holds only `func() any`.
The lookup by short name scans the full map (`smithy-go/type_registry.go:49`), so it is O(n) for each error that does not have a full ID.

### 46. Cancel the work on Ctrl+C

The repository tool `eachmodule` runs a command in each module. It catches `os.Interrupt` and cancels a context (`aws-sdk-go-v2/internal/repotools/cmd/eachmodule/main.go:112`). The child commands stop, and the tool prints the results.
The tool does this with a channel and a goroutine. Since Go 1.16, `signal.NotifyContext(ctx, os.Interrupt)` does the same in one line.

## IO tricks

### 47. Calculate a hash while the data streams

The checksum code wraps the body with `io.TeeReader(body, hash)`. The hash gets each byte that the caller reads. No second read is necessary.
To calculate two hashes in one read, it uses `io.MultiWriter`:

<!-- sdk: aws-sdk-go-v2/service/internal/checksum/middleware_compute_input_checksum.go:423 -->
```go
	if computePayloadHash && algorithm != AlgorithmSHA256 {
		sha256Hasher = sha256.New()
		batchHasher = io.MultiWriter(hasher, sha256Hasher)
	}
```

The event stream decoder uses the same trick for the CRC of each message (`smithy-go/eventstream/decode.go:64`).
Check the hash at EOF, inside `Read`. The DynamoDB CRC32 check is in `Close` (`aws-sdk-go-v2/service/dynamodb/internal/customizations/checksum.go:112`).
A caller that does not close the body, or that ignores the error of `Close`, never sees the mismatch.

### 48. A trailing checksum with a known length

An upload with a trailing checksum sends the checksum after the body. The SDK does not know the value before the end.
But it knows the length of the value, because a base64 SHA-256 value always has the same length.
Thus it can calculate the exact `Content-Length` before it sends the first byte (`aws-sdk-go-v2/service/internal/checksum/aws_chunked_encoding.go:163`).
The trailer value is a closure. It runs only after EOF.

The SDK also keeps the checksum across retries. A retry uses the value from the first attempt, even if that attempt failed (`aws-sdk-go-v2/service/internal/checksum/middleware_compute_input_checksum.go:381`).

### 49. Look at the start of a body, then give back all of the body

S3 can return an error inside a response with status 200. The SDK reads the root XML element with a `TeeReader` into a buffer.
Then it joins the buffer and the rest of the body with `io.MultiReader`. If the root element is `<Error>`, the SDK changes the status to 500. Then the normal error code and the retry run.

<!-- sdk: aws-sdk-go-v2/service/s3/internal/customizations/handle_200_error.go:61 -->
```go
	// rewind response body, forwarding the original body's Closer so closing it
	// still closes the underlying transport body (io.NopCloser would drop it).
	originalBody := response.Body
	response.Body = &replayReadCloser{
		Reader: io.MultiReader(&readBuff, originalBody),
		Closer: originalBody,
	}
```

`replayReadCloser` embeds an `io.Reader` and an `io.Closer` as two fields. `io.NopCloser` would lose the `Close` of the transport, and the connection would leak.

### 50. Keep only the last bytes for an error message

For an error, the IMDS client wants to show the body. But a body can be very large.
It uses `io.TeeReader` into a 1 KB ring buffer. The decoder reads the full stream, and the ring buffer keeps only the last 1 KB (`aws-sdk-go-v2/feature/ec2/imds/api_op_GetIAMInfo.go:77`).

Example 8 shows the hash check at EOF, the 200 error check, and the ring buffer from smithy-go:

Example 8, file `streamio/main.go`:

<!-- file: streamio/main.go -->
```go
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"hash/crc32"
	"io"
	"strings"

	smithyio "github.com/aws/smithy-go/io"
)

// checkedReader hashes the bytes while the caller reads them.
// It checks the hash at EOF, inside Read. A check in Close is not safe:
// many callers do not close, or they ignore the Close error.
type checkedReader struct {
	r    io.Reader
	h    hash.Hash32
	want string
}

func newCheckedReader(r io.Reader, want string) *checkedReader {
	h := crc32.NewIEEE()
	return &checkedReader{r: io.TeeReader(r, h), h: h, want: want}
}

func (c *checkedReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if errors.Is(err, io.EOF) {
		if got := base64.StdEncoding.EncodeToString(c.h.Sum(nil)); got != c.want {
			return n, fmt.Errorf("checksum mismatch: got %s, want %s", got, c.want)
		}
	}
	return n, err
}

// peek reads the first n bytes. Then it gives back a body that replays them.
// The new body keeps the original Close, so the connection goes back to the pool.
func peek(body io.ReadCloser, n int64) ([]byte, io.ReadCloser, error) {
	var head bytes.Buffer
	_, err := io.Copy(&head, io.LimitReader(body, n))
	replay := struct {
		io.Reader
		io.Closer
	}{io.MultiReader(bytes.NewReader(head.Bytes()), body), body}
	return head.Bytes(), replay, err
}

func crc(s string) string {
	h := crc32.NewIEEE()
	h.Write([]byte(s))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func main() {
	payload := `{"id":7,"name":"queue-a"}`

	// 1. A good body passes. A changed body fails at EOF.
	for _, body := range []string{payload, strings.Replace(payload, "7", "8", 1)} {
		_, err := io.ReadAll(newCheckedReader(strings.NewReader(body), crc(payload)))
		fmt.Println("1 checksum error:", err)
	}

	// 2. Look at the start of a 200 response. Some APIs put an error in a 200 body.
	body := io.NopCloser(strings.NewReader(`<Error><Code>SlowDown</Code></Error>`))
	head, body, _ := peek(body, 7)
	all, _ := io.ReadAll(body)
	fmt.Printf("2 head=%q isError=%v full body still there=%v\n", head, string(head) == "<Error>", len(all) == 36)

	// 3. Keep only the last 16 bytes for the error message. Memory stays small for any body size.
	ring := smithyio.NewRingBuffer(make([]byte, 16))
	broken := strings.NewReader(strings.Repeat(" ", 10_000) + `{"id": 7, "name": oops}`)
	var v map[string]any
	err := json.NewDecoder(io.TeeReader(broken, ring)).Decode(&v)
	fmt.Printf("3 decode error: %v | last bytes: %q\n", err != nil, ring.Bytes())
}
```

Output:

<!-- output: streamio -->
```text
1 checksum error: <nil>
1 checksum error: checksum mismatch: got oisdEg==, want 4bSL3A==
2 head="<Error>" isError=true full body still there=true
3 decode error: true | last bytes: "7, \"name\": oops}"
```

### 51. Do not hide or add `io.WriterTo`

The body wrapper of smithy-go has the `WriteTo` method only when the inner body has it (`smithy-go/transport/http/internal/io/safe.go:9`).
`net/http` and `io.Copy` look for `WriterTo` with a type assertion. A wrapper that always adds it calls a method that does not exist.
A wrapper that always hides it makes `io.Copy` slower.

The downloader does the reverse on purpose. It hides `WriterTo` on the body, so `io.Copy` uses the `ReaderFrom` of the destination with a pooled buffer (`aws-sdk-go-v2/feature/s3/manager/download.go:436`).

### 52. Save the start position of a stream for a retry

`Request.SetStream` calls `Seek(0, io.SeekCurrent)` and saves the result (`smithy-go/transport/http/request.go:124`).
Before a retry, it goes back to that position, not to byte 0. If the caller gives a file that is already at byte 100, the retry sends the same bytes again.

### 53. Allocate from Content-Length, but put a limit on it

smithy-go allocates the read buffer from `Content-Length`, but never more than 512 KB. A false or hostile length cannot force a large allocation.
The `+ bytes.MinRead` prevents one more growth of the buffer at EOF.

<!-- sdk: smithy-go/internal/serde/read_payload_blob.go:20 -->
```go
	if contentLength > 0 {
		presize := contentLength
		if presize > maxPresize {
			presize = maxPresize
		}

		// + bytes.MinRead prevents pointless doubling on EOF
		buf.Grow(int(presize) + bytes.MinRead)
	}
```

### 54. A header of your own turns off automatic gzip

The Go transport decompresses a gzip response only when the transport added `Accept-Encoding` itself.
DynamoDB must calculate its CRC32 on the compressed bytes. Thus the SDK sets the header itself and decompresses the body itself (`aws-sdk-go-v2/service/internal/accept-encoding/accept_encoding_gzip.go:95`).
After that, it removes `Content-Length`, because the length is not correct for the decompressed body.

### 55. Use the header slice again

<!-- sdk: aws-sdk-go-v2/service/apigateway/internal/customizations/accept_header.go:34 -->
```go
	const conHeader = "Accept"
	req.Header[conHeader] = append(req.Header[conHeader][:0], "application/json")
```

`Header.Set` allocates a new slice. This line writes into the old slice. It is a small trick for a hot path.

### 56. Calculate a tree hash in place

The Glacier tree hash writes the next level of the tree into the same slice that it reads (`aws-sdk-go-v2/service/glacier/internal/customizations/treehash.go:132`).
The write index (`i/2`) is always behind the read index (`i`), so this is safe. `h256.Sum(buf[:0])` writes into a buffer on the stack.
`io.ReadAtLeast` makes sure that each leaf has exactly 1 MB, except the last leaf.



### 57. Scan 8 bytes at a time

The JSON parser of smithy-go loads 8 bytes of a string into one `uint64` with `unsafe`. Bit operations then find a quote, a backslash or a control byte in all 8 bytes at the same time (`smithy-go/transport/http/protocol/internal/json/parser.go:327`).
A string with no special bytes moves 8 bytes for each step, not 1. This is "SIMD within a register" (SWAR). Use it only on a hot path that a profile shows.

### 58. Pass `errors.As` through an embedded error with an `As` method

`awshttp.ResponseError` embeds `*smithyhttp.ResponseError`. The `Unwrap` method that it gets from the embedded type skips the embedded error itself.
Thus the type defines `As(target any) bool` and gives the call to the embedded error (`aws-sdk-go-v2/aws/transport/http/response_error.go:31`). Then `errors.As(err, &smithyResponseError)` works for both types.

### 59. Decode a field of unknown type as `any`

The error-info struct of the JSON protocol has the field `Code any` (`aws-sdk-go-v2/internal/kitchensinktestlegacy/deserializers.go:1350`). Some services send a number or an object in `Code`.
With `any`, the decode of the whole error does not fail. A later type assertion uses the value only when it is a string.

### 60. Quote a list value in a header only when necessary

A header can hold a list, with a comma between the items. If an item contains a comma or a quote, the list breaks. S3 quotes only those items:

<!-- sdk: aws-sdk-go-v2/service/s3/serializers.go:4723 -->
```go
			if len(v.ObjectAttributes[i]) > 0 {
				escaped := string(v.ObjectAttributes[i])
				if strings.Index(string(v.ObjectAttributes[i]), `,`) != -1 || strings.Index(string(v.ObjectAttributes[i]), `"`) != -1 {
					escaped = strconv.Quote(string(v.ObjectAttributes[i]))
				}

				encoder.AddHeader(locationName).String(string(escaped))
			}
```

The reader does the reverse with `strconv.Unquote` (`smithy-go/transport/http/headerlist.go`). A simple value stays simple on the wire.

### 61. Put JSON in a header with base64

Lex sends a JSON document in a header. A header cannot safely hold every byte of JSON, so the client encodes the value with base64 (`aws-sdk-go-v2/service/lexruntimeservice/serializers.go:280`).
The deserializer decodes it (`aws-sdk-go-v2/service/lexruntimeservice/deserializers.go:563`).

### 62. NaN and infinity in JSON

JSON has no value for NaN or for infinity. `encoding/json` returns an error for them. The SDK writes them as strings:

<!-- sdk: aws-sdk-go-v2/service/rdsdata/serializers.go:730 -->
```go
		switch {
		case math.IsNaN(*v[i]):
			av.String("NaN")

		case math.IsInf(*v[i], 1):
			av.String("Infinity")

		case math.IsInf(*v[i], -1):
			av.String("-Infinity")

		default:
			av.Double(*v[i])
```

The deserializer accepts the same three strings for a number field. If your API can send these values, agree on a form like this one.

### 63. A lookup table of 256 booleans

The signer builds a table one time in `init`. Then it checks each byte of a path with one index:

<!-- sdk: smithy-go/aws-http-auth/internal/v4/strings.go:10 -->
```go
var noEscape [256]bool

func init() {
	for i := 0; i < len(noEscape); i++ {
		// AWS expects every character except these to be escaped
		noEscape[i] = (i >= 'A' && i <= 'Z') ||
			(i >= 'a' && i <= 'z') ||
			(i >= '0' && i <= '9') ||
			i == '-' ||
			i == '.' ||
			i == '_' ||
			i == '~' ||
			i == '/'
	}
}
```

A `byte` cannot be out of range for a `[256]` array, so the compiler removes the bounds check.
The CloudFront signer uses a `map[byte]byte` for the same kind of job (`aws-sdk-go-v2/feature/cloudfront/sign/policy.go:259`). An array is faster.

### 64. Count first, then allocate one time

The percent-encoder for the trace header counts the bytes that need an escape. If there are none, it returns the input with no allocation.
Otherwise it allocates the exact size, `len(s) + 2*hexCount`, and fills it (`aws-sdk-go-v2/aws/middleware/recursion_detection.go:53`).
Two passes over a short string cost less than a buffer that grows.

### 65. Store a JSON key with its comma, and slice it off for the first member

The JSON serializer stores each member key one time as `,"Name":`. For the first member of an object, it writes `key[1:]`. For the others, it writes `key` (`smithy-go/transport/http/protocol/internal/json/ext.go:9`).
There is no `if first { write(",") }` with a second write for each member.

### 66. `m[string(b)]` does not allocate

<!-- sdk: smithy-go/transport/http/protocol/internal/json/ext.go:30 -->
```go
// memberByBytes looks a member up without allocating a string for its name: the
// conversion in a map index expression is optimized away.
func memberByBytes(s *smithy.Schema, name []byte) *smithy.Schema {
	return s.Members()[string(name)]
}
```

The compiler does not make a string when the conversion is inside the map index. If you put the conversion in a separate variable, it allocates for a key that is longer than 32 bytes.
Example 18 measures both forms with `testing.AllocsPerRun`, and it also shows the comma key:

Example 18, file `allocs/main.go`:

<!-- file: allocs/main.go -->
```go
package main

import (
	"fmt"
	"testing"
)

// The key is longer than 32 bytes. Go puts a shorter conversion in a stack
// buffer, and then neither form allocates.
const long = "MessageDeduplicationIdForTheFifoQueue"

var members = map[string]int{"QueueUrl": 1, long: 2}

// sink keeps the results alive, so the compiler cannot remove the work.
var sink int

func main() {
	key := []byte(long) // a key that a parser read from the wire

	// 1. The compiler removes the string conversion inside a map index.
	inline := testing.AllocsPerRun(1000, func() { sink = members[string(key)] })

	// 2. With a separate variable, the conversion allocates.
	split := testing.AllocsPerRun(1000, func() {
		s := string(key)
		sink = members[s] + len(s)
	})
	fmt.Printf("m[string(b)]: %v allocs   s := string(b); m[s]: %v allocs\n", inline, split)

	// 3. Store the member key one time, with the comma. Use [1:] for the first member.
	keyWithComma := []byte(`,"MessageBody":`)
	var out []byte
	appendKey := func(first bool) {
		if first {
			out = append(out, keyWithComma[1:]...)
		} else {
			out = append(out, keyWithComma...)
		}
	}
	out = append(out, '{')
	appendKey(true)
	out = append(out, `"a"`...)
	appendKey(false)
	out = append(out, `"b"}`...)
	fmt.Println(string(out))
}
```

Output:

<!-- output: allocs -->
```text
m[string(b)]: 0 allocs   s := string(b); m[s]: 1 allocs
{"MessageBody":"a","MessageBody":"b"}
```

## File system tricks

### 67. Replace a file with a temp file and a rename

The SSO token cache writes to `name.tmp-<time>`, then it calls `os.Rename` (`aws-sdk-go-v2/credentials/ssocreds/sso_cached_token.go:165`).
A reader sees the old file or the new file, never half of a file. The code keeps the mode of the old file, so a secret does not become readable by all users.

The SDK version has three weak points. Example 9 fixes them:

- It does not call `Sync`. After a crash, the new file can be empty.
- It does not delete the temp file after a failure.
- It does not sync the directory, so the rename itself can disappear after a crash.

`DownloadDirectory` in the transfer manager does the cleanup correctly. It removes the temp file in a `defer` when the rename did not occur (`aws-sdk-go-v2/feature/s3/transfermanager/api_op_DownloadDirectory.go:299`).

Example 9, file `atomicwrite/main.go`:

<!-- file: atomicwrite/main.go -->
```go
package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// WriteFileAtomic replaces path with the data from write.
// Readers see the old file or the new file. They never see half a file.
func WriteFileAtomic(path string, defaultMode fs.FileMode, write func(io.Writer) error) (err error) {
	mode := defaultMode
	if fi, statErr := os.Stat(path); statErr == nil {
		mode = fi.Mode().Perm() // keep the mode of the old file, like the SDK SSO cache
	}

	dir := filepath.Dir(path)
	// The temp file must be in the same directory. Rename is atomic only on one file system.
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name()) // do not leave temp files after a failure
		}
	}()

	if err = tmp.Chmod(mode); err != nil {
		return err
	}
	if err = write(tmp); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil { // put the data on disk before the rename
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	// Sync the directory, so the rename itself survives a crash.
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func main() {
	dir, _ := os.MkdirTemp("", "atomic")
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "token.json")

	os.WriteFile(path, []byte(`{"v":1}`), 0o600)

	err := WriteFileAtomic(path, 0o644, func(w io.Writer) error {
		_, err := io.WriteString(w, `{"v":2}`)
		return err
	})
	data, _ := os.ReadFile(path)
	fi, _ := os.Stat(path)
	fmt.Printf("write 1: err=%v content=%s mode=%v\n", err, data, fi.Mode().Perm())

	err = WriteFileAtomic(path, 0o644, func(w io.Writer) error {
		io.WriteString(w, `{"v":3, "half`)
		return errors.New("disk full")
	})
	data, _ = os.ReadFile(path)
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	fmt.Printf("write 2: err=%v content=%s files=%s\n", err, data, strings.Join(names, ","))
}
```

Output:

<!-- output: atomicwrite -->
```text
write 1: err=<nil> content={"v":2} mode=-rw-------
write 2: err=disk full content={"v":2} files=token.json
```

The `logincreds` provider writes the token file in place (`aws-sdk-go-v2/credentials/logincreds/provider.go:146`). A crash during the write loses the refresh token.

### 68. Read a rotated file again for each use

The web identity token file and the container auth token file change on disk. Kubernetes rotates them.
The SDK reads the file again for each refresh, so a new token works without a restart (`aws-sdk-go-v2/credentials/stscreds/web_identity_provider.go:78`).
Do not read such a file one time at start.

### 69. A file that does not exist and a bad file are different errors

The shared config loader skips a file that it cannot open. It fails on a file that it can open but cannot parse.
It uses a typed error and `errors.As` to tell the two cases apart (`aws-sdk-go-v2/config/shared_config.go:799`).
This gives a good result for a user with no `~/.aws/config` file, and a clear error for a user with a bad file.

### 70. Find a symlink loop with the set of ancestors only

`UploadDirectory` keeps a set of the directories on the current path. It adds a directory before it goes into it and removes it after.

<!-- sdk: aws-sdk-go-v2/feature/s3/transfermanager/api_op_UploadDirectory.go:265 -->
```go
		if _, loop := ancestors[absPath]; loop {
			u.setErr(fmt.Errorf("traversed duplicate path %s", absPath))
			return
		}
		subFiles, err := u.traverseFolder(absPath)
		if err != nil {
			u.setErr(fmt.Errorf("error when traversing folder %s: %v", absPath, err))
			return
		}
		// Mark this directory as active for all children, then unmark it
		// once done so sibling subtrees can legitimately enter the same dir.
		ancestors[absPath] = struct{}{}
		for _, f := range subFiles {
			u.traverse(filepath.Join(path, f), key, ch, ancestors)
		}
		delete(ancestors, absPath)
```

A global "visited" set would skip a second link to the same directory. The set of ancestors finds only a real loop.

### 71. Check for a path that goes out of the directory

`DownloadDirectory` uses `filepath.Rel` to make sure that an object key does not write outside the target directory (`aws-sdk-go-v2/feature/s3/transfermanager/api_op_DownloadDirectory.go:243`).
But it rejects each path that contains `..`, for example `logs/a..b.txt`. Check each path segment instead, or use `os.Root` (Go 1.24). `os.Root` does the check in the kernel.

### 72. Use the hash of a name as a cache file name

The SSO cache file name is the SHA-1 of the session name. The login cache uses SHA-256 (`aws-sdk-go-v2/credentials/logincreds/token.go:24`).
A hash gives a safe file name for any input, and the length is always the same. The user input never goes into the path.

## Code generation tricks

### 73. One model, many outputs, and `go:generate` for each

The SDK generates `aws/defaults/defaults.go` and the `DefaultsMode` enum from one JSON file.
It runs the same generator on a test JSON file to make a golden file for the generator itself (`aws-sdk-go-v2/internal/codegen/generate_defaults.go:4`).

The generator files have a build tag, so they stay out of the normal build: `//go:build codegen` or `//go:build ignore`.
smithy-go `ptr/generate.go` imports the package that it writes into, `ptr`. It reads the list of types from a hand-written file in that package.
Thus the list of types is Go code, not a separate config file.

Example 12 generates typed enums from a JSON model. It uses `go/format` to run gofmt on the output. A bad template fails at once:

Example 12, file `gogenerate/model.json`:

<!-- file: gogenerate/model.json -->
```json
{
  "enums": [
    {"name": "QueueState", "values": ["ACTIVE", "DELETING", "PURGING"]},
    {"name": "Tier", "values": ["standard", "fifo"]}
  ]
}
```

Example 12, file `gogenerate/gen.go`:

<!-- file: gogenerate/gen.go -->
```go
//go:build ignore

// gen.go reads model.json and writes enums_gen.go.
// The build tag "ignore" keeps this file out of the normal build.
package main

import (
	"bytes"
	"encoding/json"
	"go/format"
	"log"
	"os"
	"strings"
	"text/template"
)

var tmpl = template.Must(template.New("enums").Funcs(template.FuncMap{
	"title": func(s string) string { return strings.ToUpper(s[:1]) + strings.ToLower(s[1:]) },
}).Parse(`// Code generated by gen.go from model.json. DO NOT EDIT.

package main
{{range .Enums}}{{$n := .Name}}
type {{$n}} string

const (
{{- range .Values}}
	{{$n}}{{title .}} {{$n}} = "{{.}}"
{{- end}}
)

// Values returns all known values. New values from the server still decode.
func ({{$n}}) Values() []{{$n}} {
	return []{{$n}}{ {{- range .Values}}"{{.}}", {{end -}} }
}
{{end}}`))

func main() {
	raw, err := os.ReadFile("model.json")
	if err != nil {
		log.Fatal(err)
	}
	var model struct {
		Enums []struct {
			Name   string
			Values []string
		}
	}
	if err := json.Unmarshal(raw, &model); err != nil {
		log.Fatal(err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, model); err != nil {
		log.Fatal(err)
	}
	// format.Source does the gofmt step. Bad template output fails here, not later.
	src, err := format.Source(buf.Bytes())
	if err != nil {
		log.Fatalf("generated code does not parse: %v\n%s", err, buf.Bytes())
	}
	if err := os.WriteFile("enums_gen.go", src, 0o644); err != nil {
		log.Fatal(err)
	}
}
```

Example 12, file `gogenerate/main.go`:

<!-- file: gogenerate/main.go -->
```go
package main

//go:generate go run gen.go

import "fmt"

// The generator emits each const with its type, so a type switch or an
// "any" value keeps the type. (transfermanager/types forgets this.)
func main() {
	fmt.Println(QueueState("").Values())
	fmt.Println(Tier("").Values())

	var v any = QueueStateActive
	_, typed := v.(QueueState)
	fmt.Println("const keeps its type:", typed)
}
```

Output, after `go generate`:

<!-- output: gogenerate -->
```text
[ACTIVE DELETING PURGING]
[standard fifo]
const keeps its type: true
```

Give a type to each constant in the block. In `transfermanager/types`, only the first constant of each enum block has the type. The other constants have no type. They are plain strings (`aws-sdk-go-v2/feature/s3/transfermanager/types/types.go:142`).
Thus `any(ChecksumAlgorithmSha1)` is a `string`, not a `ChecksumAlgorithm`.

### 74. The standard header for generated code

Start each generated file with `// Code generated ... DO NOT EDIT.`. Go tools, linters and GitHub find this line.
30,710 files in the SDK have the header from `smithy-go-codegen`. A different 490 files have the header from `updatemodulemeta`.
Thus a script can find the 103 hand-written files in `service/` with one `grep`.

The header text is a string in the generator, so it can be wrong. `internal/endpoints/awsrulesfn/partitions.go:1` names a directory that does not exist.

### 75. A version constant in a generated file, not `-ldflags`

Each module has `go_module_metadata.go`. The release tool writes the version into it:

<!-- sdk: aws-sdk-go-v2/service/sqs/go_module_metadata.go:1 -->
```go
// Code generated by internal/repotools/cmd/updatemodulemeta DO NOT EDIT.

package sqs

// goModuleVersion is the tagged release for this module
const goModuleVersion = "1.52.6"
```

The client puts this value into the User-Agent. This works for a library, because a library cannot use `-ldflags`.

### 76. One file that lists the generated files

Each service has a `generated.json` file. It lists all the files that the generator owns (47 for SQS).
A tool or a person can see at once which files to edit and which files not to edit.

### 77. One module for each service

Each of the 400+ services is its own Go module, with a `replace` line that points to the rest of the repository.
A program that uses SQS does not download the code of EC2. The repository has 491 `go.mod` files.
The `Makefile` turns a target name into a path: `tidy-modules-internal_protocoltest` runs in `internal/protocoltest`.

### 78. Endpoint rules as a flat array (a BDD)

The endpoint rules of each service are a binary decision diagram. The generator writes it as a flat `[]int32`, with three numbers for each node.
A small shared function walks the array. A negative reference means "take the other edge". A value above 100,000,000 is a result.

<!-- sdk: smithy-go/endpoints/private/bdd/evaluate.go:9 -->
```go
func Evaluate(nodes []int32, root int32, evalCond func(int) bool) int32 {
	ref := root
	for {
		if ref >= resultOffset {
			return ref - resultOffset
		}
		if ref == 1 || ref == -1 {
			return 0 // NoMatchRule
		}

		complement := ref < 0
		nodeIdx := ref
		if complement {
			nodeIdx = -ref
		}
		base := (nodeIdx - 1) * intsPerNode
		condIdx := nodes[base]
		hi := nodes[base+1]
		lo := nodes[base+2]

		if complement != evalCond(int(condIdx)) {
			ref = hi
		} else {
			ref = lo
		}
```

The rules for SQS are 14 nodes. There is no tree of `if` statements, and the array has no pointers for the GC.
Generate data, not code, when the logic is the same for each input.

### 79. Waiters compile to plain comparisons

The model describes a waiter with a JMESPath expression. The generator turns it into Go code with plain `==` comparisons (`aws-sdk-go-v2/service/dynamodb/api_op_DescribeTable.go:315`).
The program does not need a JMESPath library. The `Retryable` field is a function, so you can replace the generated logic.

### 80. Sealed interfaces for unions and documents

A union type is an interface with an unexported method, for example `isContentBlock()`. Only the package can add a member.
A type switch on the union is safe, because nobody can add a new type outside the package.
Each generated struct embeds `noSmithyDocumentSerde`, a type alias for `document.NoSerde`. The embedded marker gives each struct a property without one more exported name.

### 81. Generate the middleware steps from one template

The five step types of smithy-go (`step_initialize.go` and the others) come from one template, `middleware/generate.go`.
The comment in the template says that the old design used about 10% of all allocations. The new design is a linked list of decorators.
When you have five types that are almost the same, generate them from one template. Do not copy and edit them by hand.




### 82. Functional options as method values

```go
type withPresignExpires time.Duration

func (w withPresignExpires) options(o *PresignOptions) { o.Expires = time.Duration(w) }

// The option is a method value. It needs no closure.
opt := withPresignExpires(15 * time.Minute).options
```

The S3 presign client uses this form (`aws-sdk-go-v2/service/s3/api_client.go:1130`). The value of the option is the receiver.

### 83. A file name suffix is a build constraint

`default_read_seeker_write_to_windows.go` builds only on Windows, because of the `_windows` suffix (`aws-sdk-go-v2/feature/s3/manager/default_read_seeker_write_to_windows.go:3`). There is no `//go:build` line.
Windows gets a pooled upload buffer by default. The other systems get a version that does nothing.
The suffixes are `_GOOS`, `_GOARCH`, and `_GOOS_GOARCH`, for example `_linux_arm64.go`.

### 84. Wire recursive types in one `init` function, in topological order

A schema can refer to itself, for example a tree node with children. A Go variable that refers to itself in its initializer is an initialization cycle, and the build fails.
The generator first declares each schema with no members. Then it adds all members in one `func init()`, in dependency order (`smithy-go/codegen/smithy-go-codegen/src/main/java/software/amazon/smithy/go/codegen/CodegenVisitor.java:341`).

### 85. Let the compiler remove what the generator does not need

The generator writes the private serde helpers for lists and maps into both the root package and the `types` package. Some of them are never called.
The Go linker removes code that is never called, so a simple generator costs nothing in the binary.
For unused variables and imports, the generated code uses `_ = x` and `var _ = rulesfn.StringSlice(nil)`. Without these lines, `go build` fails with "declared and not used".

### 86. A function literal that runs at once gives each generated expression its own scope

The endpoint code builds each expression inside `func() string { ... }()`. Each expression can use the same temporary names, for example `out`, and they cannot collide.
The signer properties use the same form: `func() smithy.Properties { ... }()`.

### 87. Rename a field that collides with a method

A Go struct cannot have a field and a method with the same name. A model member called `String` or `Error` would break the build.
The generator adds `_` to those names, for example `String_` (`smithy-go/codegen/smithy-go-codegen/src/main/java/software/amazon/smithy/go/codegen/SymbolVisitor.java:107`).

### 88. Get the ID of a middleware from a typed nil pointer

`(*v4.ComputePayloadSHA256)(nil).ID()` gives the ID with no instance (`aws-sdk-go-v2/codegen/smithy-aws-go-codegen/src/main/java/software/amazon/smithy/aws/go/codegen/AssembleMiddlewareStack.java:263`).
The `ID` method does not read its receiver, so a nil pointer works. The insert code then uses that ID as the anchor.

### 89. Tell "unset" from "zero"

A Go `int32` cannot show the difference between "the caller sent 0" and "the caller did not set a value". A `*int32` can.
The generator removes the `@default` value from some shapes so that their fields become pointers (`aws-sdk-go-v2/codegen/smithy-aws-go-codegen/src/main/java/software/amazon/smithy/aws/go/codegen/customization/RemoveDefaults.java:69`).
Where a pointer is too much, it uses a convention: `0` means the default and `-1` means "off". The S3 `100-continue` limit works this way.

### 90. Return a literal `nil`, not a nil pointer in an interface

The generated identity lookup checks `o.Credentials != nil` and returns a literal `nil` when it is not set (`smithy-go/codegen/smithy-go-codegen/src/main/java/software/amazon/smithy/go/codegen/integration/auth/SigV4AuthScheme.java:148`).
An interface that holds a nil `*T` is not equal to `nil`. A caller that checks `if r == nil` would miss it and then call a method on a nil pointer.

### 91. `fmt.Sprint` of a map is a stable key

The endpoint discovery cache uses `fmt.Sprintf("%v", identifiers)` as its key, where `identifiers` is a map (`aws-sdk-go-v2/codegen/smithy-aws-go-codegen/src/main/java/software/amazon/smithy/aws/go/codegen/EndpointDiscoveryGenerator.java:363`).
Since Go 1.12, `fmt` prints map keys in sorted order. Thus two equal maps always give the same string. Example 19 shows this.

### 92. Make the generator output the same on each run

The generators sort many things: the imports, the members, the types in the registry, and the query keys. A generated file that changes on each run makes a large diff and hides real changes.
The readers found places that do not sort: a `HashMap` of doc links and a `HashSet` of auth schemes. They also found a `TreeSet` whose compare method looks at only two of three fields, so different items collapse into one.
If your generator uses a map, sort its keys before you write.

### 93. Read all output of a command before you wait for it

The Java helper that runs `gofmt` and `go` reads all of the output before it waits for the process (`smithy-go/codegen/smithy-go-codegen/src/main/java/software/amazon/smithy/go/codegen/CodegenUtils.java:69`). A different test helper waits first, and it can deadlock when the output is more than the pipe buffer (about 64 KB).
Go has the same rule: read all of `cmd.StdoutPipe()` before you call `cmd.Wait()`. `cmd.Output()` and `cmd.CombinedOutput()` do this for you.

### 94. Fixed indexes for hot traits, and a static method on a nil pointer

A smithy-go schema has traits, for example `@jsonName` or `@httpHeader`. The common traits have a fixed index (`smithy-go/traits/index.go:3`). The schema keeps them in a slice, plus a `uint64` bit mask for "declared here". Rare traits go into a map.
The generic lookup needs the index of a type, not of a value. It calls the method on the zero value of `T`:

<!-- sdk: smithy-go/schema.go:293 -->
```go
	if it, ok := Trait(zero).(IndexableTrait); ok {
		idx := it.TraitIndex()
		if idx >= len(s.indexed) {
			return zero, false
```

`T` is a pointer type, for example `*traits.JSONName`, so its zero value is a nil pointer. `TraitIndex` does not read the receiver, so the call is safe.
This gives a method of the type, not of a value, which Go does not have as a feature.

### 95. One signer core and a small interface for each algorithm

The `aws-http-auth` module has one signer core for SigV4 and SigV4A. The core builds the canonical request and the string to sign.
The last step is an interface with one method, `SignString(string) (string, error)` (`smithy-go/aws-http-auth/internal/v4/signer.go:42`). SigV4 gives an HMAC implementation. SigV4A gives an ECDSA implementation.
The two algorithms share all of the canonical rules, so a fix to one rule fixes both.

## Testing tricks

### 96. Capture the request with a sentinel error

Add a middleware at the end of the Finalize step, after `Signing`. It stores the final request and returns a sentinel error.
The test checks `errors.Is(err, errCaptured)`. No HTTP server and no mock transport are necessary.
The generated protocol tests use this trick (`aws-sdk-go-v2/internal/protocoltest/awsrestjson/request_snapshot_test.go:35`).

### 97. Check only the steps that matter, in order

`sra_operation_order_test.go` gets the stack and keeps only the IDs from a list. Then it compares the order.
An SDK upgrade that adds a middleware does not break the test. A change that moves `Signing` before `ResolveAuthScheme` breaks it.

### 98. Compare JSON as data, with `UseNumber`

The snapshot tests decode both bodies and compare them with `reflect.DeepEqual`. Key order and spaces do not matter.
They use `UseNumber`. A `float64` cannot hold every `int64`, so a serializer bug that rounds a number would hide (`aws-sdk-go-v2/internal/protocoltest/awsrestjson/request_snapshot_test.go:186`).
smithy-go also has `testing.JSONEqual`, `URLFormEqual` and an XML sort for the same purpose.
On a mismatch, `CompareReaders` prints `hex.Dump` of the two bodies. You can see the byte that is different.

### 99. Remove the headers that change on each run

The snapshot format drops `Authorization`, `X-Amz-Date`, `User-Agent` and the invocation ID before the compare.
Check the stable parts of a header with a regular expression instead, for example the scope in `Authorization`.

### 100. Run the same test on HTTP/1.1 and HTTP/2, and check the protocol

`TestReadTimeoutStallMidBody` loops over `map[string]bool{"h1": false, "h2": true}`. Then it checks `resp.Proto`. Example 15 uses a slice, so the subtests run in a fixed order.
A test that falls back to HTTP/1.1 without a message passes, but it proves nothing.
The server promises 1000 bytes with `Content-Length`, sends 5, and then waits on `r.Context().Done()`. This makes a stall in the middle of the body.

### 101. A sentinel from `DialContext`

The DNS test in the transfer manager uses a dialer that saves the address and returns a sentinel error (`aws-sdk-go-v2/feature/s3/transfermanager/rrdns_test.go:43`).
No socket opens. The test checks which IP address the client selected.

### 102. A fake server that checks the client

The clock skew test has a fake server that reads `X-Amz-Date` from the request. It rejects the request when the time is more than 4 minutes from its own clock (`aws-sdk-go-v2/internal/kitchensinktest/clock_skew_test.go:17`).
The test thus checks the real signing time that the SDK uses, not a value from a stub.

### 103. Test vectors as JSON, shared by all the SDKs

`aws/middleware/testdata/clock-skew-test-cases.json` has the clock skew cases as data. Each case is a list of operations with a client time and a server time.
The SDKs in other languages run the same file. Put the rules of a protocol in data, and each implementation can run the same test.

### 104. Seams for time, sleep and random values

`internal/sdk/time.go` has `NowTime`, `Sleep` and `SleepWithContext` as package variables. `TestingUseNopSleep` sets them and returns a function that sets them back:

<!-- sdk: aws-sdk-go-v2/internal/sdk/time.go:55 -->
```go
func TestingUseNopSleep() func() {
	SleepWithContext = noOpSleepWithContext
	Sleep = noOpSleep

	return func() {
		SleepWithContext = sleepWithContext
		Sleep = time.Sleep
	}
}
```

`internal/rand.Reader` is an `io.Reader`. A test puts 16 zero bytes into it, and the request ID becomes a fixed UUID (`aws-sdk-go-v2/aws/middleware/middleware_test.go:19`).
The cost of a global seam: tests that change it cannot use `t.Parallel`. Only 5 test files in the two repositories use `t.Parallel`.
The better design is a parameter. The signer takes the signing time as an argument, so its golden tests need no global (`aws-sdk-go-v2/aws/signer/v4/v4_test.go:67`).
The backoff has a `randFloat64` field, so a test can set the jitter to 0.5 (`aws-sdk-go-v2/aws/retry/standard_test.go:208`).

### 105. Run the same suite in two modes with `t.Setenv`

`retry2026_test.go` calls `t.Setenv("AWS_NEW_RETRIES_2026", "true")` and runs the suite again. `t.Setenv` sets the value back after the test.
The IMDS tests still use `os.Setenv` without a reset (`aws-sdk-go-v2/feature/ec2/imds/api_client_test.go:88`). Use `t.Setenv`.

### 106. Clear the full environment for config tests

`awstesting.StashEnv` saves the environment, clears it, and keeps only `PATH` and `HOME`. Then the config tests set `AWS_CONFIG_FILE` to a file that does not exist.
Thus the real `~/.aws` of the developer cannot change the result of a test (`aws-sdk-go-v2/config/shared_test.go:92`).

### 107. Generate the TLS certificates when the test starts

`internal/awstesting/certificate_utils.go` makes a CA, a server certificate and a client certificate in `init`.
The repository has no private keys in it. The tests can do mutual TLS.

### 108. Small readers and writers for tests

`awstesting.EndlessReader` returns data forever. `awstesting.DiscardAt` is `io.Discard` with `WriteAt`. smithy-go `testing.ByteLoop` returns one byte forever until you close it.
A tracked body with an `atomic` counter checks that the SDK closes each body exactly one time (`aws-sdk-go-v2/internal/kitchensinktest/response_body_close_test.go:46`).

### 109. Differential fuzz tests with the standard library as the oracle

smithy-go has its own fast JSON parser. `FuzzParserDifferential` gives each input to that parser and to `encoding/json`.
If one parser accepts the input and the other rejects it, that is a bug (`smithy-go/transport/http/protocol/internal/json/fuzz_test.go:40`).
A normal fuzz test finds only panics. A differential fuzz test finds wrong answers.

The CBOR fuzz test has a `fuzz` build tag, because it runs one million times. Its comment lists the bugs it found (`smithy-go/encoding/cbor/fuzz_test.go:1`).

### 110. Benchmarks for contention

`credential_cache_bench_test.go` runs with 1, 10, 100 and up to 10,000 goroutines in `b.Run`. Each goroutine runs `b.N` calls.
The benchmark measures the lock contention, not the speed of one goroutine. `BenchmarkWriteAtBufferParallel` uses `b.RunParallel` for the same purpose.


### 111. Fill each field with its own name

The transfer manager copies fields from its own input types to the S3 input types. A JSON list, shared with the other AWS SDKs, names each field that it must copy.
The test sets each string field to the name of the field, so `CacheControl` gets the value `"CacheControl"` (`aws-sdk-go-v2/feature/s3/transfermanager/mapping_reference_test.go:689`).
Then it checks each output field. If the code copies `CacheControl` into `ContentType`, the output shows the wrong name. A test that puts the same value in all fields cannot find this swap.
A second test uses `reflect.TypeFor[T]().FieldByName` to check that each field in the list exists. Thus a new S3 field that the copy does not know about breaks the test.

Example 17 does the same for a mapper to `sqs.SendMessageInput`. One mapper has two swapped fields, and the test finds them:

Example 17, file `fieldmap/mapper.go`:

<!-- file: fieldmap/mapper.go -->
```go
package fieldmap

import "github.com/aws/aws-sdk-go-v2/service/sqs"

// Job is our own type. ToSQS maps it to the SDK input.
type Job struct {
	Queue   string
	Body    string
	DedupID string
	GroupID string
}

func (j Job) ToSQS() *sqs.SendMessageInput {
	return &sqs.SendMessageInput{
		QueueUrl:               &j.Queue,
		MessageBody:            &j.Body,
		MessageDeduplicationId: &j.DedupID,
		MessageGroupId:         &j.GroupID,
	}
}

// toSQSSwapped has a bug that a test with one value for all fields cannot find.
func (j Job) toSQSSwapped() *sqs.SendMessageInput {
	return &sqs.SendMessageInput{
		QueueUrl:               &j.Queue,
		MessageBody:            &j.Body,
		MessageDeduplicationId: &j.GroupID, // swapped
		MessageGroupId:         &j.DedupID, // swapped
	}
}
```

Example 17, file `fieldmap/mapper_test.go`:

<!-- file: fieldmap/mapper_test.go -->
```go
package fieldmap

import (
	"reflect"
	"slices"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// mapping lists each source field and its destination field.
var mapping = map[string]string{
	"Queue":   "QueueUrl",
	"Body":    "MessageBody",
	"DedupID": "MessageDeduplicationId",
	"GroupID": "MessageGroupId",
}

// fillWithNames sets each string field to its own name: Queue = "Queue".
// Then a value in the output tells you which input field it came from.
func fillWithNames[T any]() T {
	var v T
	rv := reflect.ValueOf(&v).Elem()
	for i := range rv.NumField() {
		if f := rv.Field(i); f.Kind() == reflect.String {
			f.SetString(rv.Type().Field(i).Name)
		}
	}
	return v
}

// badFields returns the source fields that did not arrive at their destination.
func badFields(out any) []string {
	ov := reflect.ValueOf(out).Elem()
	var bad []string
	for src, dst := range mapping {
		if got := reflect.Indirect(ov.FieldByName(dst)); !got.IsValid() || got.String() != src {
			bad = append(bad, src)
		}
	}
	slices.Sort(bad)
	return bad
}

// TestMappingTableIsComplete fails when a new string field on Job has no
// mapping, or when the SDK renames a destination field.
func TestMappingTableIsComplete(t *testing.T) {
	src := reflect.TypeFor[Job]()
	for f := range src.Fields() {
		if _, ok := mapping[f.Name]; !ok {
			t.Errorf("Job.%s has no mapping", f.Name)
		}
	}
	dst := reflect.TypeFor[sqs.SendMessageInput]()
	for s, d := range mapping {
		if _, ok := dst.FieldByName(d); !ok {
			t.Errorf("mapping %s -> %s: SendMessageInput has no field %s", s, d, d)
		}
	}
}

func TestToSQS(t *testing.T) {
	if bad := badFields(fillWithNames[Job]().ToSQS()); len(bad) > 0 {
		t.Fatalf("fields not mapped: %v", bad)
	}
}

// TestFindsSwap proves that the trick finds a swap.
func TestFindsSwap(t *testing.T) {
	bad := badFields(fillWithNames[Job]().toSQSSwapped())
	if want := []string{"DedupID", "GroupID"}; !slices.Equal(bad, want) {
		t.Fatalf("badFields = %v, want %v", bad, want)
	}
}
```

Output of `go test -v`. I removed the durations:

<!-- output: fieldmap -->
```text
=== RUN   TestMappingTableIsComplete
--- PASS: TestMappingTableIsComplete
=== RUN   TestToSQS
--- PASS: TestToSQS
=== RUN   TestFindsSwap
--- PASS: TestFindsSwap
PASS
```

### 112. Read one byte at a time

The aws-chunked decoder tests run each case two times: with the normal reader, and with `iotest.OneByteReader` (`aws-sdk-go-v2/service/internal/awschunked/decoding_test.go:17`).
A parser that assumes that one `Read` returns a full line or a full header fails with one byte at a time. A network can split data at any byte.
`testing/iotest` also has `HalfReader`, `DataErrReader`, `TimeoutReader` and `ErrReader` for the same purpose.

### 113. Find `testdata` from the source file

```go
_, filename, _, _ := runtime.Caller(0)
root := filepath.Join(filepath.Dir(filename), "testdata")
```

The directory tests use this (`aws-sdk-go-v2/feature/s3/transfermanager/upload_directory_test.go:45`). The path stays correct when a helper in a different package or directory runs the test.

### 114. Fake time with `testing/synctest`, and no global seams

The SDK makes time testable with package variables (trick 104). The cost is that those tests cannot run in parallel.
No test in the two repositories uses `testing/synctest` (Go 1.25). Inside `synctest.Test`, `time.Now`, `time.Sleep` and timers use a fake clock. The clock moves forward only when all goroutines in the bubble wait.

The SDK sleeps with `time.NewTimer` (`aws-sdk-go-v2/internal/sdk/time.go:33`). So a bubble can run the real retryer, with the real jitter backoff, in fake time.
The HTTP client must be in memory. A real socket does not let the bubble know that a goroutine waits.

Example 16, file `fakeclock/fakeclock_test.go`:

<!-- file: fakeclock/fakeclock_test.go -->
```go
package fakeclock

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// downClient is an in-memory aws.HTTPClient. It always returns 503.
// It does no network IO, so synctest can see when all goroutines wait.
type downClient struct{ calls atomic.Int32 }

func (c *downClient) Do(r *http.Request) (*http.Response, error) {
	c.calls.Add(1)
	return &http.Response{
		StatusCode: http.StatusServiceUnavailable,
		Header:     http.Header{"Content-Type": {"application/x-amz-json-1.0"}},
		Body:       io.NopCloser(strings.NewReader(`{"__type":"ServiceUnavailable"}`)),
		Request:    r,
	}, nil
}

func newClient(hc aws.HTTPClient) *sqs.Client {
	return sqs.New(sqs.Options{
		Region: "us-east-1", HTTPClient: hc,
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: "AKID", SecretAccessKey: "SECRET"}, nil
		}),
		// The real default backoff, with real jitter. No test hook.
		Retryer: retry.NewStandard(func(o *retry.StandardOptions) { o.MaxAttempts = 5 }),
	})
}

// TestRealBackoffInFakeTime runs 5 attempts with the real jitter backoff.
// The backoff sleeps for seconds, but the test ends in milliseconds.
func TestRealBackoffInFakeTime(t *testing.T) {
	wallStart := time.Now()
	synctest.Test(t, func(t *testing.T) {
		hc := &downClient{}
		start := time.Now() // inside the bubble, this is the fake clock
		_, err := newClient(hc).GetQueueUrl(t.Context(), &sqs.GetQueueUrlInput{QueueName: aws.String("q")})
		waited := time.Since(start)

		if err == nil || hc.calls.Load() != 5 {
			t.Fatalf("want 5 failed attempts, got %d, err=%v", hc.calls.Load(), err)
		}
		// Four retries, i = 1..4. Each backoff is random in [0, 2^i s), so the sum is below 2+4+8+16 = 30 s.
		if waited <= 0 || waited >= 30*time.Second {
			t.Fatalf("fake wait %v is not in (0, 30s)", waited)
		}
	})
	if real := time.Since(wallStart); real > 2*time.Second {
		t.Fatalf("the test took %v of real time", real)
	}
}

// TestDeadlineStopsRetries: a 1 second deadline stops the retry loop.
// The time check is exact, because the fake clock does not move by itself.
func TestDeadlineStopsRetries(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		start := time.Now()
		_, err := newClient(&downClient{}).GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String("q")})
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("want DeadlineExceeded, got %v", err)
		}
		if waited := time.Since(start); waited > time.Second {
			t.Fatalf("the call ran %v after its 1s deadline", waited)
		}
	})
}
```

Output of `go test -v`. I removed the durations:

<!-- output: fakeclock -->
```text
=== RUN   TestRealBackoffInFakeTime
--- PASS: TestRealBackoffInFakeTime
=== RUN   TestDeadlineStopsRetries
--- PASS: TestDeadlineStopsRetries
PASS
```

The real run time is less than one second. Without the bubble, the first test would wait up to 30 seconds.
My first version of this test had the limit 15 seconds. The SDK passes the attempt numbers 1 to 4 to the backoff, not 0 to 3. The test failed in about one run of three, because the jitter is random.
Run a test with random values many times, for example with `go test -count=200`, before you trust it.


### 115. Make a wrong result easy to see

These tests choose their input so that a bug gives an output that is clearly wrong:

- Each part of a download has its own byte pattern (A, B, C). A part at the wrong offset shows at once (`aws-sdk-go-v2/feature/s3/transfermanager/api_op_DownloadObject_integ_test.go:73`).
- The old file on disk is longer than the new object. If the code does not truncate, the old bytes stay at the end (`aws-sdk-go-v2/feature/s3/transfermanager/download_directory_test.go:900`).
- The read buffer is `make([]byte, 4, 9)`. A reader that writes up to `cap(p)` and not `len(p)` fails (`aws-sdk-go-v2/feature/s3/transfermanager/concurrent_reader_test.go:87`).
- After a decode, the test writes `0xAA` over the input buffer. A value that still points into a pooled buffer changes (`smithy-go/transport/http/protocol/internal/cbor/zz_alias_test.go:16`).
- The mock STS returns the `RoleArn` of the input as the access key. One check of the output proves that the input arrived (`aws-sdk-go-v2/credentials/stscreds/assume_role_provider_test.go:31`).
- The jitter source returns `1 - 1/2^53`, the largest `float64` below 1. The test gets the exact maximum delay (`aws-sdk-go-v2/aws/retry/jitter_backoff_test.go:12`).

### 116. Small wrappers that show only some interfaces

The S3 tests wrap a `bytes.Reader` in types that show only `Seek`, only `Len`, or only `Read` (`aws-sdk-go-v2/service/s3/internal/customizations/write_get_object_response_test.go:17`).
Each wrapper forces one code path: a known length, a chunked body, or a rewind. A different helper overrides only `Seek` to fail, to test the error path after a hash (`smithy-go/aws-http-auth/internal/v4/signer_test.go:426`).
The credential cache tests embed two mocks in an anonymous struct, for example `struct{ mockProvider; mockHandleFailToRefresh }`. Each case then has the optional interfaces that it needs (`aws-sdk-go-v2/aws/credential_cache_test.go:434`).

### 117. Test the canonical form without the crypto

The signer test uses a "finalizer" that returns the string to sign as the signature (`smithy-go/aws-http-auth/internal/v4/signer_test.go:31`). The test can then compare readable text, not a hash.
For ECDSA, the signature is random, so a golden value is not possible. The SigV4A tests fix the string to sign and check the signature with `ecdsa.Verify` and the public key.

### 118. Wait for background work by joining its `singleflight` key

The bearer token cache refreshes in the background with the key `"async-refresh"`. The test calls `DoChan` on the same group with the same key and a function that does nothing (`smithy-go/auth/bearer/token_cache_test.go:506`).
If a refresh runs at that time, the test joins it and waits until it ends. No sleep and no test hook are necessary.

### 119. Find a file that is still open: close it again

The upload test keeps each `*os.File` that the uploader opens. After the upload, it calls `Close()` again. If the result is `os.ErrClosed`, the uploader closed the file (`aws-sdk-go-v2/feature/s3/transfermanager/upload_directory_test.go:707`).
This works on each platform. `os.Stat` cannot tell you if a file is open.

### 120. Force one order of two events

`TestUploadFirstErrorWins` must check that a real error replaces a "context canceled" error, and not the reverse. With real time, the order is random.
The test uses a fake context with a done channel that it closes itself, and a body that blocks until that moment (`aws-sdk-go-v2/feature/s3/transfermanager/api_op_UploadObject_test.go:1143`).
The order is then the same on each run.

### 121. Remove the Finalize step to test a deserializer with a bad response

`s.Finalize.Clear()` removes the retry loop, the signing and the length checks. A fake transport can then send a hand-built response that breaks the spec, and the real deserializer reads it (`aws-sdk-go-v2/internal/kitchensinktestcbor/dense_map_null_test.go:63`).
`s.Initialize.Remove("OperationInputValidation")` lets an empty input go past the validation.

### 122. A fake clock that moves one minute for each read

The retry middleware test sets `sdk.NowTime` to a function that adds one minute for each call (`aws-sdk-go-v2/aws/retry/middleware_test.go:402`). The times in the result then show how many times the code read the clock.
The same test makes the token bucket exactly one retry large. If the code does not give a token back, the next retry fails.

### 123. Run an external test corpus

smithy-go runs the JSONTestSuite corpus against its JSON parser (`smithy-go/transport/http/protocol/internal/json/jsontestsuite_test.go:74`). The prefix of each file name gives the expected result:
`y_` must pass, `n_` must fail, and `i_` must give the same result as `encoding/json`. A map lists each case that differs on purpose, with a reason.

### 124. Fuzz with a structure, not only with bytes

`FuzzSerializer` reads the fuzz bytes one at a time and builds a random JSON tree from them, with a depth limit (`smithy-go/transport/http/protocol/internal/json/fuzz_test.go:146`).
Then it serializes the tree and checks that it reads back the same. The fuzzer explores trees, not random bytes that the parser rejects at once.

### 125. A compile-time guard for a type from a different module

```go
var _ interface{ ErrorCode() string } = (*smithy.GenericAPIError)(nil)
```

The retry tests depend on this method of a type from smithy-go (`aws-sdk-go-v2/aws/retry/clockskew_test.go:80`). If smithy-go removes the method, the build fails with a clear message, not the test with a strange result.

### 126. Add a test to code that you do not own, with `go test -overlay`

The `-overlay` flag gives the build a virtual file. You can add a test file to a package and leave the files on disk as they are.
I used this to prove a bug in a clean clone. `git status` stayed empty.

```sh
cd aws-sdk-go-v2/service/kinesis
printf '{"Replace":{"%s/zz_probe_test.go":"/tmp/probe_test.go"}}' "$PWD" > /tmp/overlay.json
go test -overlay=/tmp/overlay.json -run TestNilLimit .
```

Go does not let an overlay replace a file in `GOMODCACHE`. Thus you must use a clone, not the module cache.

### 127. Example: tests for a client

This test file uses the tricks from this section. It checks the wire format of `SendMessage` with no network, and the order of the security steps.
It runs a stall test on HTTP/1.1 and HTTP/2, with a check of the protocol. It has a differential fuzz test and an `Example` test.

Example 15, file `testkit/range.go`:

<!-- file: testkit/range.go -->
```go
package testkit

import (
	"strconv"
	"strings"
)

// TotalSize reads the total size from a Content-Range value, for example
// "bytes 0-99/1000". It returns false for a value it does not understand.
func TotalSize(contentRange string) (int64, bool) {
	rest, ok := strings.CutPrefix(contentRange, "bytes ")
	if !ok {
		return 0, false
	}
	span, total, ok := strings.Cut(rest, "/")
	if !ok || total == "*" {
		return 0, false
	}
	first, last, ok := strings.Cut(span, "-")
	if !ok {
		return 0, false
	}
	f, err1 := parseNum(first)
	l, err2 := parseNum(last)
	t, err3 := parseNum(total)
	if err1 != nil || err2 != nil || err3 != nil || f > l || l >= t {
		return 0, false
	}
	return int64(t), true
}

// parseNum accepts only canonical decimal text: no sign, no leading zero.
// The fuzz test found "01". (The SDK INI parser uses base 0, so "010" means 8.)
func parseNum(s string) (uint64, error) {
	if len(s) > 1 && s[0] == '0' {
		return 0, strconv.ErrSyntax
	}
	return strconv.ParseUint(s, 10, 63)
}
```

Example 15, file `testkit/testkit_test.go`:

<!-- file: testkit/testkit_test.go -->
```go
package testkit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"slices"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/smithy-go/middleware"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// errCaptured is a control signal, not a failure. It stops the call after signing.
var errCaptured = errors.New("request captured")

// captureRequest adds a middleware at the end of Finalize, after "Signing".
// It copies the final request and stops. No network call happens.
func captureRequest(got **smithyhttp.Request) func(*middleware.Stack) error {
	return func(s *middleware.Stack) error {
		return s.Finalize.Add(middleware.FinalizeMiddlewareFunc("Capture",
			func(ctx context.Context, in middleware.FinalizeInput, _ middleware.FinalizeHandler) (
				middleware.FinalizeOutput, middleware.Metadata, error,
			) {
				*got = in.Request.(*smithyhttp.Request)
				return middleware.FinalizeOutput{}, middleware.Metadata{}, errCaptured
			}), middleware.After)
	}
}

func testClient() *sqs.Client {
	return sqs.New(sqs.Options{
		Region: "us-east-1",
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: "AKID", SecretAccessKey: "SECRET"}, nil
		}),
	})
}

// jsonEqual compares JSON as data. Key order and spaces do not matter.
// UseNumber keeps big int64 values exact, so a rounding bug cannot hide.
func jsonEqual(t *testing.T, got, want []byte) {
	t.Helper()
	decode := func(b []byte) any {
		d := json.NewDecoder(bytes.NewReader(b))
		d.UseNumber()
		var v any
		if err := d.Decode(&v); err != nil {
			t.Fatalf("bad JSON %s: %v", b, err)
		}
		return v
	}
	if g, w := decode(got), decode(want); !reflect.DeepEqual(g, w) {
		t.Fatalf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestSendMessageWireFormat(t *testing.T) {
	var req *smithyhttp.Request
	_, err := testClient().SendMessage(context.Background(), &sqs.SendMessageInput{
		QueueUrl:     aws.String("https://sqs.us-east-1.amazonaws.com/1/q"),
		MessageBody:  aws.String("hi"),
		DelaySeconds: 5,
	}, func(o *sqs.Options) { o.APIOptions = append(o.APIOptions, captureRequest(&req)) })
	if !errors.Is(err, errCaptured) {
		t.Fatalf("want errCaptured, got %v", err)
	}

	// Check the stable parts. Skip the parts that change on each run (date, signature).
	if got := req.Header.Get("X-Amz-Target"); got != "AmazonSQS.SendMessage" {
		t.Errorf("X-Amz-Target = %q", got)
	}
	auth := req.Header.Get("Authorization")
	if !regexp.MustCompile(`^AWS4-HMAC-SHA256 Credential=AKID/\d{8}/us-east-1/sqs/aws4_request`).MatchString(auth) {
		t.Errorf("Authorization = %q", auth)
	}
	body, _ := io.ReadAll(req.GetStream())
	jsonEqual(t, body, []byte(`{"QueueUrl":"https://sqs.us-east-1.amazonaws.com/1/q","DelaySeconds":5,"MessageBody":"hi"}`))
}

// TestSecurityOrder checks only the steps that matter for safety, in order.
// New middleware from an SDK upgrade does not break it.
func TestSecurityOrder(t *testing.T) {
	var ids []string
	grab := func(s *middleware.Stack) error {
		ids = s.Finalize.List()
		return errCaptured
	}
	testClient().GetQueueUrl(context.Background(), &sqs.GetQueueUrlInput{QueueName: aws.String("q")},
		func(o *sqs.Options) { o.APIOptions = append(o.APIOptions, grab) })

	want := []string{"Retry", "ResolveAuthScheme", "GetIdentity", "Signing"}
	var got []string
	for _, id := range ids {
		if slices.Contains(want, id) {
			got = append(got, id)
		}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v (full: %v)", got, want, ids)
	}
}

// TestReadTimeoutStall runs the same test on HTTP/1.1 and HTTP/2.
func TestReadTimeoutStall(t *testing.T) {
	// A slice, not a map: the subtests then run in the same order each time.
	for _, tc := range []struct {
		name string
		h2   bool
	}{{"h1", false}, {"h2", true}} {
		h2 := tc.h2
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", "1000") // promise 1000 bytes
				w.Write([]byte("hello"))                 // send 5
				w.(http.Flusher).Flush()
				<-r.Context().Done() // then go silent
			}))
			srv.EnableHTTP2 = h2
			srv.StartTLS()
			t.Cleanup(srv.Close)

			trusted := srv.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
			client := awshttp.NewBuildableClient().
				WithReadTimeout(100 * time.Millisecond).
				WithTransportOptions(func(tr *http.Transport) { tr.TLSClientConfig = trusted })

			req, _ := http.NewRequest("GET", srv.URL, nil)
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()

			// A test that falls back to HTTP/1.1 passes and proves nothing. Check the protocol.
			if want := map[bool]string{false: "HTTP/1.1", true: "HTTP/2.0"}[h2]; resp.Proto != want {
				t.Fatalf("proto = %s, want %s: the test does not use the intended protocol", resp.Proto, want)
			}
			_, err = io.ReadAll(resp.Body)
			var rte *awshttp.ResponseTimeoutError
			if !errors.As(err, &rte) {
				t.Fatalf("want ResponseTimeoutError, got %v", err)
			}
		})
	}
}

// FuzzTotalSize is a differential fuzz test. fmt.Sscanf is the oracle.
// Each input that one parser accepts and the other rejects is a bug.
func FuzzTotalSize(f *testing.F) {
	for _, s := range []string{"bytes 0-99/1000", "bytes 5-5/6", "bytes */1000", "bytes 9-1/10", "bytes 0-9/10x"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		got, ok := TotalSize(s)

		var first, last, total int64
		var tail string
		n, _ := fmt.Sscanf(s, "bytes %d-%d/%d%s", &first, &last, &total, &tail)
		oracleOK := n == 3 && first >= 0 && first <= last && last < total &&
			s == fmt.Sprintf("bytes %d-%d/%d", first, last, total) // only canonical text
		if ok != oracleOK || (ok && got != total) {
			t.Fatalf("%q: TotalSize=(%d,%v) oracle=(%d,%v)", s, got, ok, total, oracleOK)
		}
	})
}

// ExampleTotalSize runs as a test. The Output comment is the assertion.
func ExampleTotalSize() {
	fmt.Println(TotalSize("bytes 0-99/1000"))
	fmt.Println(TotalSize("bytes */1000"))
	// Output:
	// 1000 true
	// 0 false
}
```

Output of `go test -v`. I removed the durations:

<!-- output: testkit -->
```text
=== RUN   TestSendMessageWireFormat
--- PASS: TestSendMessageWireFormat
=== RUN   TestSecurityOrder
--- PASS: TestSecurityOrder
=== RUN   TestReadTimeoutStall
=== RUN   TestReadTimeoutStall/h1
=== RUN   TestReadTimeoutStall/h2
--- PASS: TestReadTimeoutStall
    --- PASS: TestReadTimeoutStall/h1
    --- PASS: TestReadTimeoutStall/h2
=== RUN   FuzzTotalSize
=== RUN   FuzzTotalSize/seed#0
=== RUN   FuzzTotalSize/seed#1
=== RUN   FuzzTotalSize/seed#2
=== RUN   FuzzTotalSize/seed#3
=== RUN   FuzzTotalSize/seed#4
--- PASS: FuzzTotalSize
    --- PASS: FuzzTotalSize/seed#0
    --- PASS: FuzzTotalSize/seed#1
    --- PASS: FuzzTotalSize/seed#2
    --- PASS: FuzzTotalSize/seed#3
    --- PASS: FuzzTotalSize/seed#4
=== RUN   ExampleTotalSize
--- PASS: ExampleTotalSize
PASS
```

The first version of `TotalSize` used `strconv.ParseUint` alone. In a few seconds, the differential fuzz test found an input that fails:

```text
"bytes 0-0/01": TotalSize=(1,true) oracle=(1,false)
```

`ParseUint` accepts a zero at the start of a number. The fix is `parseNum`. After the fix, the fuzz test ran 5.3 million inputs in 30 seconds with no failure.
The SDK INI parser has a worse version of this problem: it uses base 0, so `max_attempts = 010` means 8 (`aws-sdk-go-v2/config/internal/ini/value.go:62`).
`go test -fuzz` saves each input that fails in `testdata/fuzz/`. After that, a normal `go test` runs it each time.

### 128. Example: a fake for a paginator, and a guard for a loop

Example 14, file `fakepager/main.go`:

<!-- file: fakepager/main.go -->
```go
package main

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// fakeLister implements sqs.ListQueuesAPIClient. That interface has one method,
// so a fake is small. No HTTP server is necessary.
type fakeLister struct {
	pages [][]string
	calls int
}

func (f *fakeLister) ListQueues(_ context.Context, in *sqs.ListQueuesInput, _ ...func(*sqs.Options)) (*sqs.ListQueuesOutput, error) {
	i := f.calls
	f.calls++
	out := &sqs.ListQueuesOutput{QueueUrls: f.pages[i]}
	if i+1 < len(f.pages) {
		out.NextToken = new(fmt.Sprint("page-", i+1)) // Go 1.26: new(expr) replaces aws.String
	}
	return out, nil
}

// The SDK writes this guard for *sqs.Client. Write the same guard for your fakes.
var _ sqs.ListQueuesAPIClient = (*fakeLister)(nil)

// allQueues is the code under test. It takes the interface, not *sqs.Client.
func allQueues(ctx context.Context, api sqs.ListQueuesAPIClient) ([]string, error) {
	var urls []string
	p := sqs.NewListQueuesPaginator(api, &sqs.ListQueuesInput{}, func(o *sqs.ListQueuesPaginatorOptions) {
		// The default is false. Without this line, a server that sends the same
		// token again makes this loop run forever.
		o.StopOnDuplicateToken = true
	})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		urls = append(urls, page.QueueUrls...)
	}
	return urls, nil
}

func main() {
	fake := &fakeLister{pages: [][]string{{"q1", "q2"}, {"q3"}, {"q4"}}}
	urls, err := allQueues(context.Background(), fake)
	fmt.Println(urls, err, "calls:", fake.calls)

	// A server bug sends the same token again. StopOnDuplicateToken stops the loop.
	loop := &loopLister{}
	urls, _ = allQueues(context.Background(), loop)
	fmt.Println("loop server: pages read:", loop.calls, "urls:", urls)
}

// loopLister always returns the same NextToken.
type loopLister struct{ calls int }

func (l *loopLister) ListQueues(context.Context, *sqs.ListQueuesInput, ...func(*sqs.Options)) (*sqs.ListQueuesOutput, error) {
	l.calls++
	return &sqs.ListQueuesOutput{QueueUrls: []string{"same"}, NextToken: new("again")}, nil
}
```

Output:

<!-- output: fakepager -->
```text
[q1 q2 q3 q4] <nil> calls: 3
loop server: pages read: 2 urls: [same same]
```

The generated paginators have `StopOnDuplicateToken`, but its default is `false`. If a server sends the same token again, the loop never stops.
I found this with a fake: my first version of this program did not stop. Set the option to `true`.

### 129. Example: print the middleware stack

This program uses the sentinel error trick to print the full stack of `GetQueueUrl`:

Example 4, file `stackdump/main.go`:

<!-- file: stackdump/main.go -->
```go
package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/smithy-go/middleware"
)

// errStop is a sentinel. It stops the operation before it sends a request.
var errStop = errors.New("stop: stack captured")

func main() {
	client := sqs.New(sqs.Options{Region: "us-east-1"})

	var steps [][]string
	capture := func(s *middleware.Stack) error {
		steps = [][]string{s.Initialize.List(), s.Serialize.List(), s.Build.List(), s.Finalize.List(), s.Deserialize.List()}
		// Add a middleware at the very start. It returns the sentinel, so no request goes out.
		return s.Initialize.Add(middleware.InitializeMiddlewareFunc("Stop",
			func(context.Context, middleware.InitializeInput, middleware.InitializeHandler) (
				middleware.InitializeOutput, middleware.Metadata, error,
			) {
				return middleware.InitializeOutput{}, middleware.Metadata{}, errStop
			}), middleware.Before)
	}

	_, err := client.GetQueueUrl(context.Background(),
		&sqs.GetQueueUrlInput{QueueName: aws.String("q")},
		func(o *sqs.Options) { o.APIOptions = append(o.APIOptions, capture) })
	fmt.Println("stopped early:", errors.Is(err, errStop))

	names := []string{"Initialize", "Serialize", "Build", "Finalize", "Deserialize"}
	for i, ids := range steps {
		fmt.Printf("%-11s %s\n", names[i], strings.Join(ids, " > "))
	}
}
```

Output:

<!-- output: stackdump -->
```text
stopped early: true
Initialize  OperationInputValidation
Serialize   setOperationInput > ResolveEndpoint > OperationSerializer
Build       ClientRequestID > UserAgent > RecursionDetection
Finalize    InterceptBeforeRetryLoop > Retry > InterceptAttempt > ResolveAuthScheme > GetIdentity > ResolveEndpointV2 > disableHTTPS > ComputePayloadHash > setLegacyContextSigningOptions > Signing
Deserialize AddRawResponseToMetadata > ResponseErrorWrapper > RequestIDRetriever > OperationDeserializer > RecordResponseTiming > RequestResponseLogger
```

## Test smells that I found in the SDK tests

The full read of the 409 hand-written test files found many tests that cannot fail, or that do not test what their names say.
The SDK is a well tested project. These mistakes are common in all Go code, so it is good to know them.

Example 19 shows why each check is wrong:

Example 19, file `testsmells/main.go`:

<!-- file: testsmells/main.go -->
```go
package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"time"
)

// Each line shows a check that the SDK tests use, and why it does not test what it seems to test.
func main() {
	// 1. errors.As into *any matches every error. The check can never fail.
	var anyErr any
	fmt.Println("1 errors.As(io.EOF, &anyErr):", errors.As(io.EOF, &anyErr))
	var canceled interface{ CanceledError() bool }
	fmt.Println("  errors.As(io.EOF, &canceled):", errors.As(io.EOF, &canceled))

	// 2. strings.Contains with an empty expectation is always true.
	fmt.Println("2 strings.Contains(\"any error\", \"\"):", strings.Contains("any error", ""))

	// 3. bytes.EqualFold ignores case. For binary data, 'A' and 'a' are different bytes.
	fmt.Println("3 bytes.EqualFold({0x41}, {0x61}):", bytes.EqualFold([]byte{0x41}, []byte{0x61}))

	// 4. time.FixedZone takes seconds, not hours.
	_, off := time.Date(2014, 4, 4, 0, 0, 0, 0, time.FixedZone("PDT", -7)).Zone()
	fmt.Println("4 FixedZone(\"PDT\", -7) offset in seconds:", off)

	// 5. -0 == +0, so == cannot check the sign. Use math.Signbit.
	negZero := math.Copysign(0, -1)
	fmt.Println("5 -0 == 0:", negZero == 0, "  Signbit(-0):", math.Signbit(negZero))

	// 6. All NaN values are unequal, also to themselves. Compare the bits.
	nan := math.NaN()
	fmt.Println("6 NaN == NaN:", nan == nan, "  same bits:", math.Float64bits(nan) == math.Float64bits(nan))

	// 7. fmt prints map keys in sorted order, so a printed map is a stable cache key.
	k1 := fmt.Sprint(map[string]string{"b": "2", "a": "1"})
	k2 := fmt.Sprint(map[string]string{"a": "1", "b": "2"})
	fmt.Println("7 fmt.Sprint(map) is stable:", k1 == k2, k1)
}
```

Output:

<!-- output: testsmells -->
```text
1 errors.As(io.EOF, &anyErr): true
  errors.As(io.EOF, &canceled): false
2 strings.Contains("any error", ""): true
3 bytes.EqualFold({0x41}, {0x61}): true
4 FixedZone("PDT", -7) offset in seconds: -7
5 -0 == 0: true   Signbit(-0): true
6 NaN == NaN: false   same bits: true
7 fmt.Sprint(map) is stable: true map[a:1 b:2]
```

| Smell | Where in the SDK | What to do |
|---|---|---|
| `errors.As(err, &e)` with `var e interface{}` matches each error | `aws-sdk-go-v2/aws/signer/v4/middleware_test.go:78`, `aws-sdk-go-v2/internal/v4a/middleware_test.go:127` | Use the concrete type, or an interface with a method. |
| `strings.Contains(err.Error(), "")` is always true | `aws-sdk-go-v2/service/internal/checksum/algorithms_test.go:240` | Check `expectErr == ""` first, and then require `err == nil`. |
| `strings.Contains` with the two arguments swapped | `aws-sdk-go-v2/service/bedrockruntime/internal/testing/eventstream_test.go:623` | Read it as "haystack, needle". |
| A helper returns a named `ok bool` that it never sets, so the caller skips the other checks | `aws-sdk-go-v2/credentials/endpointcreds/internal/client/client_test.go:105` | Do not use a named result for a test helper. |
| `t.Fatal` in a goroutine of the code under test | `aws-sdk-go-v2/feature/s3/manager/upload_test.go:862` | Use `t.Error`, or send the error to the test goroutine. |
| `InsecureSkipVerify: verifyTLS`, the opposite of the flag | `aws-sdk-go-v2/feature/s3/transfermanager/setup_integ_test.go:93` | Name the flag and the field the same way, or write `!verifyTLS`. |
| `bytes.EqualFold` to compare binary data | `aws-sdk-go-v2/feature/s3/transfermanager/setup_integ_test.go:301` | Use `bytes.Equal`. |
| `time.FixedZone("PDT", -7)`, which is 7 seconds | `aws-sdk-go-v2/aws/protocol/eventstream/header_value_test.go:92` | Write `-7*60*60`. |
| An `Example` with no `// Output:` comment never runs | `aws-sdk-go-v2/config/example_test.go:54` | Add `// Output:`. A lowercase `// output:` also works. |
| `b.ResetTimer()` inside the `b.N` loop, or no `b.N` loop | `aws-sdk-go-v2/feature/s3/manager/internal/integration/uploader/main_test.go:191`, `aws-sdk-go-v2/internal/strings/strings_test.go:75` | Use `for b.Loop()` (Go 1.24). It handles the timer for you. |
| All `b.RunParallel` goroutines write into one shared variable | `aws-sdk-go-v2/feature/dynamodb/attributevalue/marshaler_test.go:648` | Declare the variable inside the `RunParallel` function. `go test -race -bench` finds this. |
| A test that depends on a different test that runs first | `smithy-go/document/json/encoder_test.go:141` | Build the test data inside each test. Run with `-shuffle=on`. |
| A 512 MB test value in a package variable | `smithy-go/transport/http/protocol/internal/json/benchmark_test.go:798` | Build large data inside the benchmark, or with `sync.OnceValue`. |
| `log.Fatal` in a test | `aws-sdk-go-v2/service/internal/integrationtest/s3/express_test.go:76` | Use `t.Fatal`. `log.Fatal` exits the process and skips the cleanup. |

I proved three of these smells with a run. The others are clear from the code.

- **Order dependency.** `go test -run 'TestEncoder_Encode$' ./document/json` fails. The full package passes.
- **Large allocation.** The JSON test binary used 1.6 GB of memory (`maximum resident set size 1636679680`) for `-test.run '^$'`, which runs no test.
- **Data race.** `go test -race -run '^$' -bench BenchmarkUnmarshalOneMember -benchtime=200x` in `feature/dynamodb/attributevalue` printed `WARNING: DATA RACE`.

### 130. Make each test fail one time before you trust it

Most of the smells above have one cause: nobody saw the test fail. Before you merge a test, break the code or the expectation for a moment, and check that the test fails with a clear message.
Example 17 does this inside the test file: `TestFindsSwap` proves that the check finds a real bug. The `go test -fuzz` step in example 15 did the same for `TotalSize`.

## Lessons from reading each value

Readers read 137,655 distinct strings and comments of the generated code. They found 624 items. Most are errors in the documentation that the generator copies from the models. The items below are about Go, or they can change the behavior of a program.

### 131. A doc comment line that starts with a tab is a code block

godoc shows an indented line as preformatted code. The generator writes some summaries as `//<tab>text`, when the model text starts with a space after `<p>` (`smithy-go/codegen/smithy-go-codegen/src/main/java/software/amazon/smithy/go/codegen/DocumentationConverter.java`).
Then `go doc` shows the summary as a code block, and the comment does not start with the name of the type. 1,141 generated files have such a line. Bug 30 shows the output of `go doc`.
In your own generator, trim the text before you write `// `. Run `gofmt`: since Go 1.19, it reformats doc comments, and you can see the problem in the diff.

### 132. Test the documentation converter like any other parser

The converter from HTML to godoc makes three errors that repeat in thousands of comments:

- It drops the space after a link with no URL: `<a>ListParents</a> enables` becomes `ListParentsenables`.
- It writes the text of a link that contains `<code>` two times: `[PutRecordBatch]PutRecordBatch`.
- It writes a summary with a tab, as above.

Doc comments are part of the API. A table test with HTML input and the expected godoc output finds each of these errors.

### 133. Keep the cause when you return a new error

A waiter that reaches a failure state returns `fmt.Errorf("waiter state transitioned to Failure")`. The caller cannot use `errors.As` to get the `AccessDeniedException` or its message. Bug 29 proves this.
About 1,448 generated operations return `fmt.Errorf("expected middleware input to be of type *CreateAssetInput ")`. The message has a space at the end, and it does not say which type arrived.
Use `%w` for the cause and `%T` for the type: `fmt.Errorf("expected *CreateAssetInput, got %T", in)`.

### 134. A waiter with equal minimum and maximum delay does not back off

`HybridADUpdatedWaiter` and `LanguageModelCompletedWaiter` set both `MinDelay` and `MaxDelay` to 120 seconds (`aws-sdk-go-v2/service/directoryservice/api_op_DescribeHybridADUpdate.go:209`).
The waiter polls each 120 seconds with no backoff. If you set only `MinDelay` to a higher value, the validation fails, because `MinDelay` is then more than `MaxDelay`. Set both values together.

### 135. The Go name and the wire value can differ

- The enum constant `ExecutionStateCancelled` has the wire value `"canceled"` (`aws-sdk-go-v2/service/arcregionswitch/types/enums.go:368`). Compare with the constant, not with a string that you type.
- SNS `InvalidParameterValueException.ErrorCode()` returns `"ParameterValueInvalid"` (`aws-sdk-go-v2/service/sns/types/errors.go:297`). Match an error with `errors.As` and the type, not with the name of the type as a string.

### 136. Count the skipped tests

33 generated protocol test files call `t.Skip` for cases from the shared Smithy suite. One example: the client does not have a test for default values in the input (`aws-sdk-go-v2/internal/protocoltest/awsrestjson/api_op_OperationWithDefaults_test.go:227`).
A skipped test is not a passed test. Run `go test -json ./... | grep '"Action":"skip"'`, and keep a list of the skips with a reason for each.

## Small Go idioms

### 137. Bit flags from the top bit down

<!-- sdk: aws-sdk-go-v2/aws/logging.go:19 -->
```go
const (
	LogSigning ClientLogMode = 1 << (64 - 1 - iota)
	LogRetries
	LogRequest
```

The flags start at bit 63. A new flag at the end of the list does not change the value of an old flag.
`internal/endpoints/v2.EndpointVariant` uses the same idea.

### 138. Use a full slice expression, so `append` cannot write into the slice of the caller

<!-- sdk: aws-sdk-go-v2/config/resolve_credentials.go:605 -->
```go
	// force allocation of a new slice if the additional options are
	// needed, to prevent overwriting the passed in slice of options.
	optFns = optFns[:len(optFns):len(optFns)]
```

The capacity becomes equal to the length. The next `append` must allocate a new array.
Two bugs in the [bugs section](#bugs-that-i-found-and-the-lesson-from-each) come from code without this line.

### 139. Optional interfaces

The credential cache checks the provider for `HandleFailRefreshCredentialsCacheStrategy` and `AdjustExpiresByCredentialsCacheStrategy`.
The retry code checks the request for `interface{ RewindStream() error }` before a retry.
The metrics code checks for `metrics.NopMeter`. If there is no real meter, it skips `httptrace.WithClientTrace`, which is expensive:

<!-- sdk: smithy-go/transport/http/metrics.go:20 -->
```go
	// WithClientTrace is an expensive operation - avoid calling it if we're
	// not actually using a metrics sink.
	if _, ok := meter.(metrics.NopMeter); ok {
		return parent, client, nil
	}
```

A type assertion on an optional method lets you add a behavior and keep the old interface.

### 140. Stack values: context values for one operation only

`middleware.WithStackValue` stores a value in a linked list inside the context. `ClearStackValues` removes all of them at the start of a new stack.

<!-- sdk: smithy-go/middleware/stack_values.go:12 -->
```go
func WithStackValue(ctx context.Context, key, value interface{}) context.Context {
	md, _ := ctx.Value(stackValuesKey{}).(*stackValues)

	md = withStackValue(md, key, value)
	return context.WithValue(ctx, stackValuesKey{}, md)
}
```

A call inside a call, for example `CreateSession` inside an S3 call, does not get the signing region of the outer call.
The key is a struct with no fields, for example `type clockSkew struct{}`. It cannot collide with a key from a different package, and it needs no allocation.

### 141. A nil receiver that is safe

```go
func (e *QueueDoesNotExist) ErrorCode() string {
	if e == nil || e.ErrorCodeOverride == nil {
		return "QueueDoesNotExist"
	}
	return *e.ErrorCodeOverride
}
```

The method works on a nil pointer. The override field lets a protocol change the error code without a new type (`aws-sdk-go-v2/service/sqs/types/errors.go:1018`).

### 142. Hide secrets with a struct tag

`awsutil.Prettify` prints `<sensitive>` for each field with the tag `sensitive:"true"` (`aws-sdk-go-v2/internal/awsutil/string_value.go:40`).
The generator adds the tag from the model. Thus a debug log does not show a password.

### 143. Generic no-op types with no size

<!-- sdk: smithy-go/metrics/nop.go:90 -->
```go
type nopInstrument[N any] struct{}
```

One generic type gives a no-op counter for `int64` and for `float64`. A struct with no fields uses no memory.

### 144. `new` with a value (Go 1.26)

Since Go 1.26, `new("jobs")` returns a `*string`. This replaces `aws.String("jobs")`, `aws.Int32(5)` and the other helpers.
Example 14 uses `new(fmt.Sprint("page-", i+1))`.


### 145. Clear one bit with `&^=`

<!-- sdk: aws-sdk-go-v2/aws/logging.go:76 -->
```go
// ClearSigning clears the Signing logging mode bit
func (m *ClientLogMode) ClearSigning() {
	*m &^= LogSigning
}
```

`&^` is "and not". It is shorter and clearer than `*m &= ^LogSigning`.

## Bugs that I found, and the lesson from each

I proved each bug with a program or a test, on the code at the commits above. Each item has the lesson for your own code.

| # | Where | What occurs | Proof | Lesson |
|---|---|---|---|---|
| 1 | `aws-sdk-go-v2/service/machinelearning/internal/customizations/predictendpoint.go:15` | `AddPredictEndpointMiddleware` does not store its function argument. Each `Predict` call panics with a nil pointer at line 41. | test: `panic ... predictendpoint.go:41` | A linter for unused parameters (`unparam`) finds this. |
| 2 | `aws-sdk-go-v2/service/kinesis/handwritten_paginators.go:67` | `DescribeStreamPaginator.NextPage` reads `*p.options.Limit`, which is nil when you do not set `Limit`. | `go test -overlay`: `NextPage panicked: runtime error: invalid memory address` | Hand-written code next to generated code gets fewer reviews. |
| 3 | `aws-sdk-go-v2/aws/signer/internal/v4/cache.go:65` | The cache of derived signing keys checks the access key ID and the day, but not the secret key. After a rotation of the secret with the same key ID, the signer uses the old key until the next day. | two secrets gave the same `Authorization`; a new signer gave a different one | The key of a cache must include each input of the value. |
| 4 | `aws-sdk-go-v2/internal/v4a/smithy.go:79` | `signingTime.Add(skew)` drops its result. SigV4A does not use the clock skew correction. | `staticcheck -checks SA4017`: `Add doesn't have side effects and its return value is ignored` | Run staticcheck in CI. `go vet` does not find this: `unusedresult` accepts only functions, not methods. |
| 5 | `smithy-go/tracing/context.go:32` | `WithSpan` calls `append` on the lineage of the parent. Two child contexts share one backing array, so child A reports span B. | program: `span of ctx A is: B` | Use `slices.Clip` (or `s[:len(s):len(s)]`) before `append` on a slice that you do not own. |
| 6 | `aws-sdk-go-v2/feature/dynamodb/expression/expression.go:180` | `Builder` has value receivers, but its map is shared. `base.WithCondition(...)` changes `base`. | program: `builder base got condition: true` | A value receiver does not copy a map or a slice. Copy them in each `With...` method. |
| 7 | `smithy-go/waiter/waiter.go:62` | `ComputeDelay(2, 5ms, 10ms, 2ms)` returns `-3ms`. | program: `waiter delay: -3ms` | Clamp a calculated delay to zero or more. |
| 8 | `aws-sdk-go-v2/aws/protocol/eventstream/header.go:46` | `Headers.Del` removes one item and then moves past the next item. Two headers with the same name next to each other: one stays. | program: `headers left after Del: 1` | Use `slices.DeleteFunc`. |
| 9 | `aws-sdk-go-v2/service/s3/express_default.go:108` | The background refresh and the shared fetch of S3 Express credentials use the context of the request. When that context ends, the shared fetch fails for all callers. | read; example 6 shows the same pattern fail | Use `context.WithoutCancel` plus your own timeout in a shared fetch. |
| 10 | `aws-sdk-go-v2/feature/s3/transfermanager/types/types.go:142` | Only the first constant of each enum block has the enum type. | read | Write the type on each constant, or generate the block. |
| 11 | `aws-sdk-go-v2/service/sqs/api_op_ListQueues.go:168` (all paginators) | `StopOnDuplicateToken` is `false` by default. A server that repeats a token makes the loop run forever. | example 14 did not stop before I set the option | Make the safe behavior the default. |
| 12 | `smithy-go/encoding/json/decoder_util.go:27` | The error inside the `for decoder.More()` loop is lost, because `endToken, err :=` shadows it. | `staticcheck -checks SA4006`: `this value of err is never used` | Run staticcheck in CI. |
| 13 | `smithy-go/aws-http-auth/internal/v4/strings.go:47` | The standalone signer hashes the body from its current position, then seeks to position 0. If the body does not start at 0, the request sends more bytes than the signature covers. | program: `signed hash == hash of sent bytes: false` | Save the start position with `Seek(0, io.SeekCurrent)`, as `smithy-go/transport/http/request.go:124` does. |
| 14 | `smithy-go/aws-http-auth/sigv4a/credentials.go:48` | The ECDSA key cache checks only the access key ID. This is the same mistake as bug 3, in a second module. | read | Write the rule for the key of a cache one time, and use it in each copy. |
| 15 | `smithy-go/codegen/smithy-go-codegen/src/main/java/software/amazon/smithy/go/codegen/GoWriter.java:863` | The generator joins build tags with `,`. That is the old `+build` syntax. With two tags, the output is `//go:build a,b`, which Go rejects. No file has two tags today, so the bug does not show yet. | `go vet`: `parsing //go:build line: invalid syntax at ,` | Join with ` && `. A test for the generator with two tags finds this. |
| 16 | `smithy-go/encoding/cbor/coerce.go:124` | `AsFloat64` accepts integers up to 2^54, but a `float64` is exact only up to 2^53. A larger value loses its last bits, with no error. | program: `in=9007199254740993 float=9007199254740992 err=<nil>` | The limit for exact integers in a `float64` is `1<<53`. |
| 17 | `aws-sdk-go-v2/service/sqs/api_client.go:890` (each service) | The retry mode feature in the User-Agent comes from a type switch on `*retry.Standard`. When you set `RetryMaxAttempts`, the SDK wraps the retryer in a different type, and the feature disappears. | program: `RetryMaxAttempts=0: m/E`, `RetryMaxAttempts=5:` (empty) | A type switch on an interface fails when a wrapper arrives. Ask the value with a method instead. |
| 18 | `aws-sdk-go-v2/service/iottwinmaker/internal/document/document.go:41` (45 services) | `UnmarshalSmithyDocument` on a lazy document fills the value, then returns the error `unsupported json type`. The cause is in the generator: `LegacyJsonProtocolDocumentUtils.java:19`. | program: `err=unsupported json type, *map[string]interface {} out=map[a:1 b:x]` | Return the error of the step that does the work, not of a second step. The reader agent said the value stays empty. A run showed that this was wrong. |
| 19 | `aws-sdk-go-v2/internal/awstesting/assert.go:123` | `AssertXML` decodes both documents into the same container, so two different documents are always "equal". | test with `-overlay`: `AssertXML(different docs) ... = true` | Make each test helper fail one time before you use it. |
| 20 | `aws-sdk-go-v2/service/s3/api_op_PutObject.go:1087` (generated presign code) | The second `append` starts again from `options.ClientOptions` and drops `withNopHTTPClientAPIOption`. Today this is harmless: a presign with a client that panics did not panic. | program: `presign ok: true` | Append to the result of the first `append`, not to the original slice. |
| 21 | `aws-sdk-go-v2/service/bedrockruntime/api_client.go:446` (each event stream operation) | An event stream call runs the stack in a goroutine and then waits on a channel. Only the Deserialize step sends on it. An error in an earlier step, for example a validation error, leaves the caller blocked forever. The context does not stop the wait. | program: `call still blocked 4 s after its 1 s deadline` | Wait with `select` on the result and on `ctx.Done()`. Send an error on the channel from each exit of the goroutine. |
| 22 | `aws-sdk-go-v2/config/internal/ini/strings.go:62` | A config value that is only one quote character, for example `region = "`, makes `LoadDefaultConfig` panic. | program: `LoadDefaultConfig panicked: runtime error: slice bounds out of range [1:0]` | Check `len(s) >= 2` before you remove two quotes. A fuzz test of the parser finds this. |
| 23 | `aws-sdk-go-v2/service/s3/deserializers.go:9285` (13 services) | Integer headers are parsed with `strconv.ParseInt(v, 0, 32)`. Base 0 reads `"010"` as 8 (octal), and accepts `0x1F` and `1_000`. This includes `Content-Length`. | program: `header "010" -> PartsCount = 8` | Use base 10 for wire formats. |
| 24 | `aws-sdk-go-v2/aws/transport/http/client.go:356` | For a 3xx with no `Location`, the SDK puts a sentinel URL in `Location`. The clean-up code deletes a header named after the sentinel, not `Location`, so the caller gets the sentinel. | program: `Location seen by caller="https://amazonaws.com/badhttpredirectlocation"` | Test the visible result of each workaround, not only that the request worked. |
| 25 | `aws-sdk-go-v2/service/dynamodb/api_op_Query.go:648` (and `Scan`) | The page token is a map. The paginator continues while the map is not `nil`. An empty map `{}` never stops the loop, and there is no check for a repeated token. | program with a fake client: `pages read before my limit of 1000: 1000` | End on `len(token) == 0`, not on `token != nil`. |
| 26 | `aws-sdk-go-v2/feature/s3/manager/buffered_read_seeker.go:54` | When the inner reader returns data and `io.EOF` in one call, and the buffer of the caller is smaller than the data, `Read` returns EOF and loses the rest. | program with `iotest.DataErrReader`: `read "hell" of "hello world"` | Return `io.EOF` only when the buffer is empty. Test each reader with `testing/iotest`. |
| 27 | `smithy-go/testing/rest.go:11` | `HasHeader` and five other helpers return their own `errors` slice type as an `error`. With no problem, that is a nil slice inside a non-nil interface. So `AssertHasHeader` returns `false` for equal headers, and it never calls `t.Error`. | program: `err == nil is false (dynamic type testing.errors)`, `AssertHasHeader(same, same) = false, t.Error calls = 0`; staticcheck SA4023 | Return a literal `nil` when the slice is empty. |
| 28 | `aws-sdk-go-v2/service/internal/serdebenchmark/restjsondataplane/api_op_PutObject_test.go:69` | The generated benchmarks put the base64 text of a blob into the body, not the bytes. `ContentLength` says 256000, but the body has 341,336 bytes. If the 30 s limit ends the loop before the warm-up ends, the percentile code indexes an empty slice and panics. | read, by the value pass | Generate test data with the same encoder that the code under test uses. |
| 29 | `aws-sdk-go-v2/service/acmpca/api_op_GetCertificateAuthorityCsr.go:325` (generated waiters) | A waiter that reaches a failure state on an error code returns a new error without `%w`. The service error and its message are lost. | program: `waiter err: waiter state transitioned to Failure`, `errors.As(err, &smithy.APIError) = false` | Wrap the cause with `%w`. |
| 30 | `aws-sdk-go-v2/service/frauddetector/types/types.go:59` (1,141 files) | A generated doc summary starts with a tab. godoc shows it as a code block, not as the summary of the type. | `go doc ./types.AggregatedVariablesImpactExplanation`: the summary is indented 8 spaces, the rest 4 | Trim the model text before you write a doc comment. |
| 31 | `aws-sdk-go-v2/service/cloudwatch/options.go:85` | The comment says that the minimum compression size must be in `[0, 1MiB]`. The code accepts up to 10,485,760 bytes (10 MiB) (`aws-sdk-go-v2/config/env_config.go:819`). | read, by the value pass | Put a limit in one constant, and use the constant in the code and in the comment. |

The other scouts' reports listed more items that I did not prove by a test, so I did not put them in this table.
Two examples: `gzipReader.Close` does not close the body when nobody read it (`aws-sdk-go-v2/service/internal/accept-encoding/accept_encoding_gzip.go:166`).
The event stream decoder does not check that `Length` is more than `HeadersLen + 16`, so `PayloadLen` can wrap around (`aws-sdk-go-v2/aws/protocol/eventstream/message.go:77`).

## The most important tricks

I removed the duplicates and kept the tricks that give the most value for the least code.

1. **Use a retry budget.** A token bucket for retries, with a refund after success, stops a retry storm (trick 11, example 3).
2. **Put the circuit breaker after `Retry`.** Make its error not retryable. Count only 5xx and network errors (example 2).
3. **Use a timeout for each attempt, and a deadline for each read.** With one timeout for the call, one hung attempt uses all of the time. See tricks 17 and 18, examples 7 and 13.
4. **Never wait on a channel without `ctx.Done()`.** Bug 21 blocks a caller forever.
5. **Use full jitter, with the cap before the jitter.** Use a longer base for throttles. Put limits on `Retry-After` (tricks 12 and 14).
6. **Share a fetch with `DoChan`.** Run the fetch with `context.WithoutCancel` and your own timeout. Let each caller leave on its own context (trick 25, examples 5 and 6).
7. **Add jitter to the refresh time, and compare expiry with `Round(0)`** (tricks 29 and 30).
8. **Keep old credentials when the source is down** (static stability, trick 19, example 10).
9. **Copy the options for each call, and use a factory for each object with state** (tricks 1 and 2, example 1).
10. **Accept one-method interfaces, and write a compile-time guard for each fake** (trick 6, example 14).
11. **Hash while you stream. Check the hash at EOF in `Read`, not in `Close`** (trick 47, example 8).
12. **Replay a body with `MultiReader`, and keep the original `Closer`** (trick 49, example 8).
13. **Drain a body before you close it, and do not hide or add `WriterTo`** (tricks 21 and 51).
14. **Write parts out of order into an `io.WriterAt`. Pin the version with `If-Match`. Report the root cause, not the cancel** (tricks 22, 23 and 35, example 11).
15. **Use a channel as a bounded buffer pool. Do not put large buffers back** (trick 34).
16. **Write a file with temp, `Sync`, rename and a directory sync. Keep the old mode** (trick 67, example 9).
17. **Generate data, not code, when the logic is the same. Format the output with `go/format`** (tricks 73 and 78, example 12).
    On a hot path, use a lookup table, slots with atomic pointers, and `m[string(b)]` (tricks 63, 44 and 66, example 18).
18. **Capture a request with a sentinel error. Compare JSON as data with `UseNumber`** (tricks 96 and 98, example 15).
19. **Use differential fuzz tests. Fill each field with its own name. Test retries in fake time with `synctest`** (tricks 109, 111 and 114, examples 15, 16 and 17).
20. **Clip a slice before `append` when you do not own it** (trick 138, bugs 5 and 6).
21. **Make each test fail one time before you trust it.** A full read of 409 test files found many checks that cannot fail (trick 130, example 19).
22. **Run staticcheck in CI.** It found two bugs in this research that `go vet` did not find (bugs 4 and 12).

## How to run the examples

Put each file at the path above it, below one directory. Use this `go.mod`:

File `go.mod`:

<!-- file: go.mod -->
```text
module example.com/awsgo

go 1.26.0

require (
	github.com/aws/aws-sdk-go-v2 v1.47.4
	github.com/aws/aws-sdk-go-v2/service/sqs v1.52.6
	github.com/aws/smithy-go v1.28.6
	golang.org/x/sync v0.24.0
)

require (
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.5.7 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.8.7 // indirect
)
```

Then run these commands:

```sh
go mod tidy
go generate ./gogenerate
go vet ./...
go run ./wellbehaved     # and the same for each directory
go test -v ./testkit ./fakeclock ./fieldmap
go test -run '^$' -fuzz=FuzzTotalSize -fuzztime=30s ./testkit
```

The examples use fake servers from `net/http/httptest`. They do not need an AWS account, credentials or network access, except to download the modules.
I ran each example with Go 1.27.2 on darwin/arm64, with `aws-sdk-go-v2 v1.47.4`, `service/sqs v1.52.6` and `smithy-go v1.28.6`.
