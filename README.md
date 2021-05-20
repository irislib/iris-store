# iris-store
[Iris store](https://iris.to/#/store) merchant backend. Receives orders via Iris private messages and replies with a bitcoin payment address. Listens to the bitcoin address for payment.


Wait until electrum is up:

```
docker compose up electrum
```

then:

```
docker compose up iris-store
```
