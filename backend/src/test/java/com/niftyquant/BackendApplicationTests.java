package com.niftyquant;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

// No database in unit tests: skip migrations; the connection pool only connects on first use.
@SpringBootTest(properties = "spring.flyway.enabled=false")
class BackendApplicationTests {

	@Test
	void contextLoads() {
	}

}
