package outbound

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestDialOutboundAddressesFallsBackFromStalledIPv6(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	winner, remote := net.Pipe()
	defer remote.Close()
	firstCancelled := make(chan struct{})
	conn, err := dialOutboundAddresses(ctx, "tcp", "443", []net.IP{
		net.ParseIP("2001:db8::1"), net.ParseIP("192.0.2.1"),
	}, func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" {
			t.Errorf("network = %q", network)
		}
		switch address {
		case "[2001:db8::1]:443":
			<-ctx.Done()
			close(firstCancelled)
			return nil, ctx.Err()
		case "192.0.2.1:443":
			return winner, nil
		default:
			t.Errorf("dialed unvalidated address %q", address)
			return nil, errors.New("unexpected address")
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if conn != winner {
		t.Fatal("did not return IPv4 connection")
	}
	select {
	case <-firstCancelled:
	case <-ctx.Done():
		t.Fatal("stalled dial was not cancelled after fallback succeeded")
	}
}

func TestDialOutboundAddressesClosesLateSuccessfulConnection(t *testing.T) {
	winner, remote := net.Pipe()
	defer remote.Close()
	late, lateRemote := net.Pipe()
	defer lateRemote.Close()
	conn, err := dialOutboundAddresses(context.Background(), "tcp", "443", []net.IP{
		net.ParseIP("2001:db8::1"), net.ParseIP("192.0.2.1"),
	}, func(ctx context.Context, _, address string) (net.Conn, error) {
		if address == "[2001:db8::1]:443" {
			<-ctx.Done()
			return late, nil
		}
		return winner, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = lateRemote.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := lateRemote.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("late connection was not closed: %v", err)
	}
}

func TestDialOutboundAddressesTriesNextImmediatelyAfterFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	winner, remote := net.Pipe()
	defer remote.Close()
	conn, err := dialOutboundAddresses(ctx, "tcp", "443", []net.IP{
		net.ParseIP("2001:db8::1"), net.ParseIP("192.0.2.1"),
	}, func(_ context.Context, _, address string) (net.Conn, error) {
		if address == "[2001:db8::1]:443" {
			return nil, errors.New("connection refused")
		}
		return winner, nil
	})
	if err != nil {
		t.Fatalf("did not try next address before fallback delay: %v", err)
	}
	_ = conn.Close()
}

func TestDialOutboundAddressesPreservesFailureAndCancellation(t *testing.T) {
	firstErr := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
	_, err := dialOutboundAddresses(context.Background(), "tcp", "443", []net.IP{
		net.ParseIP("2001:db8::1"), net.ParseIP("192.0.2.1"),
	}, func(context.Context, string, string) (net.Conn, error) { return nil, firstErr })
	if err != firstErr {
		t.Fatalf("network error was replaced: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	finished := make(chan error)
	go func() {
		_, err := dialOutboundAddresses(ctx, "tcp", "443", []net.IP{net.ParseIP("192.0.2.1")}, func(ctx context.Context, _, _ string) (net.Conn, error) {
			close(started)
			<-ctx.Done()
			return nil, ctx.Err()
		})
		finished <- err
	}()
	<-started
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("dial did not stop after cancellation")
	}
}
