// TURN-Teil: leitet WebRTC-Verkehr weiter, wenn zwei Teilnehmer wegen
// NAT/Firewall keine direkte Verbindung aufbauen koennen (coturn gibt es unter
// Windows nicht nativ, daher pion/turn).
//
// Zugangsdaten nach dem "TURN REST API"-Schema: Der Signaling-Server gibt
// zeitlich begrenzte Benutzer (expiry:peerId) mit HMAC-SHA1-Passwort aus,
// beide teilen sich turn.secret aus config.json.
package main

import (
	"fmt"
	"log"
	"net"
	"strconv"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

type turnConfig struct {
	Enabled      bool   `json:"enabled"`
	Secret       string `json:"secret"`
	PublicIP     string `json:"publicIp"`
	ListenPort   int    `json:"listenPort"`
	RelayPortMin int    `json:"relayPortMin"`
	RelayPortMax int    `json:"relayPortMax"`
	Realm        string `json:"realm"`
	// Nur zum lokalen Testen: Ziele im privaten Netz erlauben.
	AllowPrivatePeers bool `json:"allowPrivatePeers"`
}

func (c *turnConfig) applyDefaults() {
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
}

// Nur oeffentliche Adressen als Ziel erlauben. Sonst koennte ein Client den
// TURN-Server als Sprungbrett ins interne Netz oder auf localhost-Dienste des
// Servers (z. B. Plesk) missbrauchen.
func publicPeersOnly(_ net.Addr, peerIP net.IP) bool {
	return !(peerIP.IsLoopback() || peerIP.IsPrivate() || peerIP.IsUnspecified() ||
		peerIP.IsLinkLocalUnicast() || peerIP.IsLinkLocalMulticast() || peerIP.IsMulticast())
}

func startTURN(cfg turnConfig, publicIP net.IP) (*turn.Server, error) {
	if len(cfg.Secret) < 16 {
		return nil, fmt.Errorf("turn.secret fehlt oder ist zu kurz (mind. 16 Zeichen)")
	}
	if cfg.RelayPortMin > cfg.RelayPortMax || cfg.RelayPortMax > 65535 {
		return nil, fmt.Errorf("turn.relayPortMin/relayPortMax ungueltig")
	}

	addr := "0.0.0.0:" + strconv.Itoa(cfg.ListenPort)
	udpConn, err := net.ListenPacket("udp4", addr)
	if err != nil {
		return nil, fmt.Errorf("TURN UDP %s: %w", addr, err)
	}
	// TURN ueber TCP fuer Netze, die UDP komplett sperren.
	tcpListener, err := net.Listen("tcp4", addr)
	if err != nil {
		return nil, fmt.Errorf("TURN TCP %s: %w", addr, err)
	}

	permission := turn.PermissionHandler(publicPeersOnly)
	if cfg.AllowPrivatePeers {
		log.Print("WARNUNG: turn.allowPrivatePeers ist aktiv - nur zum Testen verwenden")
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
		return nil, fmt.Errorf("TURN-Server: %w", err)
	}
	log.Printf("TURN laeuft auf %s (UDP+TCP), Relay %s:%d-%d",
		addr, publicIP, cfg.RelayPortMin, cfg.RelayPortMax)
	return server, nil
}
