// KM-DEV Stream Medien-Server
//
// Ein Programm, zwei Aufgaben (je nach config.json):
//   - TURN (turn.go): Relay fuer Teilnehmer hinter strengem NAT/Firewall.
//   - SFU (sfu.go): Server-Modus. Der Host schickt seinen Stream einmal an den
//     Server, der ihn an alle Zuschauer verteilt.
//
// Konfiguration: die config.json des Signaling-Servers (Abschnitte "turn" und
// "sfu"). Die SFU haengt sich per WebSocket an den Signaling-Server (control.go).
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
)

type fileConfig struct {
	Host string     `json:"host"`
	Port int        `json:"port"`
	Turn turnConfig `json:"turn"`
	SFU  sfuConfig  `json:"sfu"`
}

func loadConfig(path string) (fileConfig, error) {
	var c fileConfig
	raw, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	// BOM entfernen, falls ein Windows-Editor eins geschrieben hat.
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, fmt.Errorf("config.json ungueltig: %w", err)
	}
	if c.Port == 0 {
		c.Port = 8443
	}
	c.Turn.applyDefaults()
	c.SFU.applyDefaults()
	return c, nil
}

func main() {
	configPath := flag.String("config", "config.json", "Pfad zur config.json des Signaling-Servers")
	flag.Parse()

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("Konfiguration: %v", err)
	}
	if !cfg.Turn.Enabled && !cfg.SFU.Enabled {
		log.Fatal("Weder turn.enabled noch sfu.enabled ist gesetzt - nichts zu tun")
	}
	publicIP := net.ParseIP(cfg.Turn.PublicIP).To4()
	if publicIP == nil {
		log.Fatalf("turn.publicIp ist keine gueltige IPv4-Adresse: %q", cfg.Turn.PublicIP)
	}

	if cfg.Turn.Enabled {
		server, err := startTURN(cfg.Turn, publicIP)
		if err != nil {
			log.Fatal(err)
		}
		defer server.Close()
	}

	if cfg.SFU.Enabled {
		s, err := newSFU(cfg.SFU, publicIP)
		if err != nil {
			log.Fatal(err)
		}
		go runControl(cfg, s)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
}
