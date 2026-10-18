// Steuerverbindung zum Signaling-Server: Die SFU verbindet sich als Client mit
// ws://127.0.0.1:<port>/media und tauscht dort SDP/ICE-Nachrichten fuer den
// virtuellen Teilnehmer "sfu" aus. Bricht die Verbindung ab, wird neu verbunden.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// Nachrichten zwischen Signaling-Server und SFU.
//
//	Signaling -> SFU: signal (room, peer, role, data), viewer-join, peer-leave, room-close
//	SFU -> Signaling: signal (room, peer, data)
type ctrlMsg struct {
	Type string          `json:"type"`
	Room string          `json:"room,omitempty"`
	Peer string          `json:"peer,omitempty"`
	Role string          `json:"role,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

func runControl(cfg fileConfig, s *sfu) {
	host := cfg.Host
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	url := fmt.Sprintf("ws://%s:%d/media", host, cfg.Port)
	delay := time.Second
	for {
		started := time.Now()
		err := controlSession(url, cfg.SFU.Secret, s)
		s.closeAll() // ohne Signaling sind alle Sitzungen verwaist
		if time.Since(started) > 30*time.Second {
			delay = time.Second // lief eine Weile -> schnell wieder verbinden
		}
		if err != nil {
			log.Printf("Signaling-Verbindung: %v - neuer Versuch in %s", err, delay)
		}
		time.Sleep(delay)
		if delay < 10*time.Second {
			delay *= 2
		}
	}
}

func controlSession(url, secret string, s *sfu) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dialCtx, dialCancel := context.WithTimeout(ctx, 5*time.Second)
	conn, _, err := websocket.Dial(dialCtx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + secret}},
	})
	dialCancel()
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	log.Printf("Mit Signaling-Server verbunden (%s)", url)

	out := make(chan ctrlMsg, 256)
	s.setSender(func(m ctrlMsg) {
		select {
		case out <- m:
		default:
			log.Print("Steuerkanal voll - Nachricht verworfen")
		}
	})
	defer s.setSender(nil)

	go func() {
		ping := time.NewTicker(20 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-out:
				data, _ := json.Marshal(m)
				wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Write(wctx, websocket.MessageText, data)
				wcancel()
				if err != nil {
					cancel()
					return
				}
			case <-ping.C:
				pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pctx)
				pcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var m ctrlMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		s.handle(m)
	}
}
