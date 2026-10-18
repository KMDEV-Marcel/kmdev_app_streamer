// KM-DEV Stream TURN-Server
//
// Kleiner TURN-Server auf Basis von pion/turn fuer Windows (coturn gibt es dort
// nicht nativ). Er leitet WebRTC-Verkehr weiter, wenn zwei Teilnehmer wegen
// NAT/Firewall keine direkte Verbindung aufbauen koennen.
//
// Zugangsdaten nach dem "TURN REST API"-Schema: Der Signaling-Server gibt
// zeitlich begrenzte Benutzer (expiry:peerId) mit HMAC-SHA1-Passwort aus,
// beide teilen sich turn.secret aus config.json.
//
// Konfiguration: der "turn"-Abschnitt der config.json des Signaling-Servers.
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
	"strconv"
	"syscall"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

type turnConfig struct {
	Secret       string `json:"secret"`
	PublicIP     string `json:"publicIp"`
	ListenPort   int    `json:"listenPort"`
	RelayPortMin int    `json:"relayPortMin"`
	RelayPortMax int    `json:"relayPortMax"`
	Realm        string `json:"realm"`
	// Nur zum lokalen Testen: Ziele im privaten Netz erlauben.
	AllowPrivatePeers bool `json:"allowPrivatePeers"`
}

func loadConfig(path string) (turnConfig, error) {
	var file struct {
		Turn turnConfig `json:"turn"`
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return file.Turn, err
	}
	// BOM entfernen, falls ein Windows-Editor eins geschrieben hat.
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	if err := json.Unmarshal(raw, &file); err != nil {
		return file.Turn, fmt.Errorf("config.json ungueltig: %w", err)
	}
	c := file.Turn
	if c.ListenPort == 0 {
		c.ListenPort = 3478
	}
	if c.RelayPortMin == 0 {
		c.RelayPortMin = 49160
	}
	if c.RelayPortMax == 0 {
		c.RelayPortMax = 49260
	}
	if c.Realm == "" {
		c.Realm = "kmdev-stream"
	}
	return c, nil
}

// Nur oeffentliche Adressen als Ziel erlauben. Sonst koennte ein Client den
// TURN-Server als Sprungbrett ins interne Netz oder auf localhost-Dienste des
// Servers (z. B. Plesk) missbrauchen.
func publicPeersOnly(_ net.Addr, peerIP net.IP) bool {
	return !(peerIP.IsLoopback() || peerIP.IsPrivate() || peerIP.IsUnspecified() ||
		peerIP.IsLinkLocalUnicast() || peerIP.IsLinkLocalMulticast() || peerIP.IsMulticast())
}

func main() {
	configPath := flag.String("config", "config.json", "Pfad zur config.json des Signaling-Servers")
	flag.Parse()

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("Konfiguration: %v", err)
	}
	if len(cfg.Secret) < 16 {
		log.Fatal("turn.secret fehlt oder ist zu kurz (mind. 16 Zeichen)")
	}
	publicIP := net.ParseIP(cfg.PublicIP).To4()
	if publicIP == nil {
		log.Fatalf("turn.publicIp ist keine gueltige IPv4-Adresse: %q", cfg.PublicIP)
	}
	if cfg.RelayPortMin > cfg.RelayPortMax || cfg.RelayPortMax > 65535 {
		log.Fatal("turn.relayPortMin/relayPortMax ungueltig")
	}

	addr := "0.0.0.0:" + strconv.Itoa(cfg.ListenPort)
	udpConn, err := net.ListenPacket("udp4", addr)
	if err != nil {
		log.Fatalf("UDP %s: %v", addr, err)
	}
	// TURN ueber TCP fuer Netze, die UDP komplett sperren.
	tcpListener, err := net.Listen("tcp4", addr)
	if err != nil {
		log.Fatalf("TCP %s: %v", addr, err)
	}

	permission := turn.PermissionHandler(publicPeersOnly)
	if cfg.AllowPrivatePeers {
		log.Print("WARNUNG: allowPrivatePeers ist aktiv - nur zum Testen verwenden")
		permission = turn.DefaultPermissionHandler
	}

	loggers := logging.NewDefaultLoggerFactory()
	loggers.DefaultLogLevel = logging.LogLevelWarn

	newGen := func() *turn.RelayAddressGeneratorPortRange {
		return &turn.RelayAddressGeneratorPortRange{
			RelayAddress: publicIP,
			Address:      "0.0.0.0",
			MinPort:      uint16(cfg.RelayPortMin),
			MaxPort:      uint16(cfg.RelayPortMax),
		}
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm:         cfg.Realm,
		AuthHandler:   turn.LongTermTURNRESTAuthHandler(cfg.Secret, loggers.NewLogger("auth")),
		LoggerFactory: loggers,
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            udpConn,
			RelayAddressGenerator: newGen(),
			PermissionHandler:     permission,
		}},
		ListenerConfigs: []turn.ListenerConfig{{
			Listener:              tcpListener,
			RelayAddressGenerator: newGen(),
			PermissionHandler:     permission,
		}},
	})
	if err != nil {
		log.Fatalf("TURN-Server: %v", err)
	}

	log.Printf("KM-DEV Stream TURN laeuft auf %s (UDP+TCP), Relay %s:%d-%d",
		addr, publicIP, cfg.RelayPortMin, cfg.RelayPortMax)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	if err := server.Close(); err != nil {
		log.Printf("Beenden: %v", err)
	}
}
